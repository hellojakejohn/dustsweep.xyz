// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Sweeper, IPermit2, ISweepAdapter, IWETH9} from "../src/Sweeper.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/* ------------------------------------------------------------------ mocks */

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s) { name = n; symbol = s; }

    function mint(address to, uint256 a) public { balanceOf[to] += a; totalSupply += a; }

    function approve(address sp, uint256 a) public virtual returns (bool) {
        allowance[msg.sender][sp] = a; return true;
    }
    function transfer(address to, uint256 a) public virtual returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) public virtual returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a; totalSupply -= a;
        (bool ok,) = msg.sender.call{value: a}(""); require(ok, "eth send");
    }
    receive() external payable { mint(msg.sender, msg.value); }
}

/// Sells any token for a fixed WETH payout. Stands in for a real venue.
contract GoodAdapter is ISweepAdapter {
    MockWETH public weth;
    uint256 public payout;
    constructor(MockWETH w, uint256 p) { weth = w; payout = p; }
    function setPayout(uint256 p) external { payout = p; }
    function sell(address token, uint256 amountIn, uint256, bytes calldata)
        external returns (uint256)
    {
        IERC20(token).transferFrom(msg.sender, address(this), amountIn);
        weth.transfer(msg.sender, payout);
        return payout;
    }
}

/// A venue that is down, a token that is a honeypot, a pool with no route.
contract RevertingAdapter is ISweepAdapter {
    function sell(address, uint256, uint256, bytes calldata) external pure returns (uint256) {
        revert("no route");
    }
}

/* ------------------------------------------------------------------- tests */

/// Unit tests for the batching, try/catch and fee logic. Forks 4663 only to
/// borrow the real Permit2 so the signature path is genuinely exercised;
/// everything else is a mock so the assertions are deterministic.
contract SweeperTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_BATCH_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    Sweeper sweeper;
    MockWETH weth;
    GoodAdapter good;
    RevertingAdapter bad;

    MockERC20 tokA;
    MockERC20 tokB;
    MockERC20 tokC;
    MockERC20 untouched;

    uint256 userPk = 0xA11CE;
    address user;
    address feeSink = address(0xFEE);

    uint256 constant PAYOUT = 0.01 ether; // WETH each good leg returns

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("rhc")); // for the real Permit2 only
        user = vm.addr(userPk);

        weth = new MockWETH();
        sweeper = new Sweeper(PERMIT2, address(weth), feeSink);
        good = new GoodAdapter(weth, PAYOUT);
        bad = new RevertingAdapter();

        sweeper.setAdapter(address(good), true);
        sweeper.setAdapter(address(bad), true);

        // the adapter needs WETH to pay out with
        weth.mint(address(good), 100 ether);
        // the sweeper unwraps to ETH, so the mock WETH needs ETH backing
        vm.deal(address(weth), 100 ether);

        tokA = new MockERC20("A", "A");
        tokB = new MockERC20("B", "B");
        tokC = new MockERC20("C", "C");
        untouched = new MockERC20("Do Not Touch", "SAFE");

        tokA.mint(user, 1000e18);
        tokB.mint(user, 1000e18);
        tokC.mint(user, 1000e18);
        untouched.mint(user, 777e18);

        vm.startPrank(user);
        tokA.approve(PERMIT2, type(uint256).max);
        tokB.approve(PERMIT2, type(uint256).max);
        tokC.approve(PERMIT2, type(uint256).max);
        untouched.approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
    }

    /* -------------------------------------------------------- permit2 sig */

    function _permit(address[] memory tokens, uint256[] memory amounts, uint256 nonce)
        internal view returns (IPermit2.PermitBatchTransferFrom memory p)
    {
        IPermit2.TokenPermissions[] memory tp = new IPermit2.TokenPermissions[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            tp[i] = IPermit2.TokenPermissions({token: tokens[i], amount: amounts[i]});
        }
        p = IPermit2.PermitBatchTransferFrom({
            permitted: tp, nonce: nonce, deadline: block.timestamp + 1 hours
        });
    }

    function _sign(IPermit2.PermitBatchTransferFrom memory p)
        internal view returns (bytes memory)
    {
        bytes32[] memory hashes = new bytes32[](p.permitted.length);
        for (uint256 i; i < p.permitted.length; ++i) {
            hashes[i] = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted[i]));
        }
        bytes32 structHash = keccak256(abi.encode(
            PERMIT_BATCH_TRANSFER_FROM_TYPEHASH,
            keccak256(abi.encodePacked(hashes)),
            address(sweeper),           // spender
            p.nonce,
            p.deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _legs(address[] memory tokens, address[] memory adapters)
        internal pure returns (Sweeper.Leg[] memory legs)
    {
        legs = new Sweeper.Leg[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            legs[i] = Sweeper.Leg({
                token: tokens[i], adapter: adapters[i], minOut: 1, data: ""
            });
        }
    }

    function _arr3(address a, address b, address c) internal pure returns (address[] memory x) {
        x = new address[](3); x[0] = a; x[1] = b; x[2] = c;
    }
    function _amt3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory x) {
        x = new uint256[](3); x[0] = a; x[1] = b; x[2] = c;
    }

    /* ------------------------------------------------- THE non-negotiables */

    /// CLAUDE.md: "Test the batch with a deliberately broken token in it. The
    /// try/catch path is the one that matters and it's the one nobody tests."
    function test_BrokenLegDoesNotStrandTheBatch() public {
        address[] memory tokens = _arr3(address(tokA), address(tokB), address(tokC));
        uint256[] memory amts   = _amt3(100e18, 100e18, 100e18);
        address[] memory adapters = _arr3(address(good), address(bad), address(good));

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 0);
        bytes memory sig = _sign(p);

        uint256 ethBefore = user.balance;
        uint256 bBefore = tokB.balanceOf(user);

        vm.prank(user);
        uint256 out = sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);

        // two legs filled, gross 0.02, fee 3%, user gets the rest as ETH
        uint256 gross = 2 * PAYOUT;
        uint256 fee = gross * 300 / 10_000;
        assertEq(out, gross - fee, "net wrong");
        assertEq(user.balance - ethBefore, gross - fee, "user did not receive ETH");
        assertEq(weth.balanceOf(feeSink), fee, "fee did not reach the sink");

        // the broken leg's token came back to the user, not stuck in the contract
        assertEq(tokB.balanceOf(user), bBefore, "broken leg token was not returned");
        assertEq(tokB.balanceOf(address(sweeper)), 0, "sweeper kept the broken token");
    }

    /// CLAUDE.md: "Test with a token you did NOT include in the permit. It must
    /// be untouched." This is the property the whole safety model rests on.
    function test_TokenOutsideThePermitIsUntouched() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        address[] memory adapters = new address[](1);
        tokens[0] = address(tokA); amts[0] = 100e18; adapters[0] = address(good);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 1);
        bytes memory sig = _sign(p);

        uint256 safeBefore = untouched.balanceOf(user);

        vm.prank(user);
        sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);

        assertEq(untouched.balanceOf(user), safeBefore, "a token outside the permit MOVED");
        assertEq(untouched.balanceOf(address(sweeper)), 0);
        assertEq(untouched.allowance(user, address(sweeper)), 0);
    }

    /// A leg cannot be pointed at a different token than the one signed for.
    function test_LegTokenMustMatchPermit() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        tokens[0] = address(tokA); amts[0] = 100e18;

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 2);
        bytes memory sig = _sign(p);

        Sweeper.Leg[] memory legs = new Sweeper.Leg[](1);
        legs[0] = Sweeper.Leg({
            token: address(untouched), adapter: address(good), minOut: 1, data: ""
        });

        vm.prank(user);
        vm.expectRevert(Sweeper.LengthMismatch.selector);
        sweeper.sweep(p, sig, legs, false, 0);
    }

    /* ------------------------------------------------------------ guards */

    function test_UnwhitelistedAdapterRejected() public {
        RevertingAdapter rogue = new RevertingAdapter();
        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        address[] memory adapters = new address[](1);
        tokens[0] = address(tokA); amts[0] = 100e18; adapters[0] = address(rogue);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 3);
        bytes memory sig = _sign(p);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(Sweeper.AdapterNotAllowed.selector, address(rogue))
        );
        sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);
    }

    function test_EveryLegFailingReverts() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        address[] memory adapters = new address[](1);
        tokens[0] = address(tokA); amts[0] = 100e18; adapters[0] = address(bad);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 4);
        bytes memory sig = _sign(p);

        vm.prank(user);
        vm.expectRevert(Sweeper.NothingFilled.selector);
        sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);
    }

    /// Documents real behaviour: LegValueTooHigh sits in the try's success
    /// block, so it is NOT caught by that catch. One over-limit leg kills the
    /// whole sweep. That is a deliberate hard backstop, but it means the user
    /// pays gas for nothing, so the front end must never submit such a leg.
    function test_OneOverLimitLegRevertsTheWholeBatch() public {
        sweeper.setMaxLegValue(0.005 ether); // below PAYOUT

        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        address[] memory adapters = new address[](1);
        tokens[0] = address(tokA); amts[0] = 100e18; adapters[0] = address(good);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 5);
        bytes memory sig = _sign(p);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(Sweeper.LegValueTooHigh.selector, address(tokA), PAYOUT)
        );
        sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);
    }

    function test_SweeperHoldsNothingAfterwards() public {
        address[] memory tokens = _arr3(address(tokA), address(tokB), address(tokC));
        uint256[] memory amts   = _amt3(100e18, 100e18, 100e18);
        address[] memory adapters = _arr3(address(good), address(good), address(good));

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 6);
        bytes memory sig = _sign(p);

        vm.prank(user);
        sweeper.sweep(p, sig, _legs(tokens, adapters), false, 0);

        assertEq(weth.balanceOf(address(sweeper)), 0, "sweeper kept WETH");
        assertEq(address(sweeper).balance, 0, "sweeper kept ETH");
        assertEq(tokA.balanceOf(address(sweeper)), 0);
        assertEq(tokA.allowance(address(sweeper), address(good)), 0, "allowance left open");
    }

    function test_FeeCannotExceedCeiling() public {
        vm.expectRevert(Sweeper.FeeTooHigh.selector);
        sweeper.setFees(501, 100);
    }
}
