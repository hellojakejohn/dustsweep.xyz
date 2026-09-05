// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Sweeper, IPermit2} from "../src/Sweeper.sol";
import {V3Adapter, IV3SwapRouter} from "../src/V3Adapter.sol";

interface IWETH9Full is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// GAP e. Everything else exercises the ETH payout against MockWETH, whose
/// `withdraw` is four lines we wrote ourselves. This runs the same leg
/// against the deployed aeWETH proxy on 4663, through the real Permit2, the
/// real SwapRouter02 and a real dead token.
///
/// Run with: forge test --fork-url rhc --match-path test/SweeperUnwrapFork.t.sol -vv
contract SweeperUnwrapForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;

    /// Real Noxa token, WETH-paired on the 1% tier, 0.585 WETH in the pool.
    address constant NOXA_TOKEN = 0x955b339944CbD4834156366D766C260C80956B44;
    uint24 constant FEE_1PCT = 10_000;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_BATCH_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    Sweeper sweeper;
    V3Adapter adapter;

    uint256 userPk = 0xA11CE;
    address user;
    address feeSink = address(0xFEE);

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("rhc"));
        user = vm.addr(userPk);

        adapter = new V3Adapter(ROUTER, WETH);
        sweeper = new Sweeper(PERMIT2, WETH, feeSink);
        sweeper.setAdapter(address(adapter), true);

        vm.deal(address(this), 100 ether);
    }

    /// The primitive on its own, against the live implementation rather
    /// than against our mock. CLAUDE.md says this was probed by hand; this
    /// is the version that runs on every `forge test`.
    function test_LiveAeWethRoundTripsExactly() public {
        uint256 ethBefore = address(this).balance;

        IWETH9Full(WETH).deposit{value: 1 ether}();
        assertEq(IERC20(WETH).balanceOf(address(this)), 1 ether, "deposit did not credit 1:1");
        assertEq(address(this).balance, ethBefore - 1 ether, "deposit took the wrong amount");

        IWETH9Full(WETH).withdraw(1 ether);
        assertEq(IERC20(WETH).balanceOf(address(this)), 0, "withdraw left WETH behind");
        assertEq(address(this).balance, ethBefore, "withdraw did not return the ETH");
    }

    /// The whole ETH-payout path end to end on real infrastructure: real
    /// Permit2 signature, real router, real dead token, real aeWETH unwrap.
    function test_FullSweepUnwrapsThroughLiveAeWeth() public {
        uint256 dust = _buyDustFor(user, 0.01 ether);
        assertGt(dust, 0, "did not acquire dust");

        vm.prank(user);
        IERC20(NOXA_TOKEN).approve(PERMIT2, type(uint256).max);

        uint256 expected = _quote(dust);
        uint256 minOut = (expected * 95) / 100;
        assertGt(minOut, 0, "quote rounded to zero, token belongs in the no-route pile");

        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        tokens[0] = NOXA_TOKEN;
        amts[0] = dust;

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 0);
        bytes memory sig = _sign(p);

        Sweeper.Leg[] memory legs = new Sweeper.Leg[](1);
        legs[0] =
            Sweeper.Leg({token: NOXA_TOKEN, adapter: address(adapter), minOut: minOut, data: ""});

        vm.deal(user, 0); // so the delta below is only what the sweep paid
        uint256 sinkBefore = IERC20(WETH).balanceOf(feeSink);

        vm.prank(user);
        uint256 out = sweeper.sweep(p, sig, legs, false, 0);

        uint256 fee = IERC20(WETH).balanceOf(feeSink) - sinkBefore;
        uint256 gross = out + fee;

        // The user was paid in native ETH, which only happens if the
        // aeWETH unwrap actually worked.
        assertEq(user.balance, out, "user was not paid in ETH");
        assertGt(out, 0, "sweep paid nothing");
        assertGe(gross, minOut, "slippage bound violated");
        assertEq(fee, (gross * 300) / 10_000, "fee is not 3% of gross");

        // Nothing stuck anywhere.
        assertEq(IERC20(WETH).balanceOf(address(sweeper)), 0, "sweeper kept WETH");
        assertEq(address(sweeper).balance, 0, "sweeper kept ETH");
        assertEq(IERC20(NOXA_TOKEN).balanceOf(address(sweeper)), 0, "sweeper kept the token");
        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0, "adapter kept WETH");
        assertEq(
            IERC20(NOXA_TOKEN).allowance(address(sweeper), address(adapter)),
            0,
            "allowance left open"
        );

        console.log("dust in       :", dust);
        console.log("gross weth    :", gross);
        console.log("fee weth      :", fee);
        console.log("user eth out  :", out);
    }

    // --- helpers ------------------------------------------------------

    function _buyDustFor(address to, uint256 wethIn) internal returns (uint256) {
        IWETH9Full(WETH).deposit{value: wethIn}();
        IERC20(WETH).approve(ROUTER, wethIn);
        return IV3SwapRouter(ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: NOXA_TOKEN,
                fee: FEE_1PCT,
                recipient: to,
                amountIn: wethIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _quote(uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(QUOTER).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: NOXA_TOKEN,
                tokenOut: WETH,
                amountIn: amountIn,
                fee: FEE_1PCT,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _permit(address[] memory tokens, uint256[] memory amounts, uint256 nonce)
        internal
        view
        returns (IPermit2.PermitBatchTransferFrom memory p)
    {
        IPermit2.TokenPermissions[] memory tp = new IPermit2.TokenPermissions[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            tp[i] = IPermit2.TokenPermissions({token: tokens[i], amount: amounts[i]});
        }
        p = IPermit2.PermitBatchTransferFrom({
            permitted: tp,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(IPermit2.PermitBatchTransferFrom memory p)
        internal
        view
        returns (bytes memory)
    {
        bytes32[] memory hashes = new bytes32[](p.permitted.length);
        for (uint256 i; i < p.permitted.length; ++i) {
            hashes[i] = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted[i]));
        }
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_BATCH_TRANSFER_FROM_TYPEHASH,
                keccak256(abi.encodePacked(hashes)),
                address(sweeper),
                p.nonce,
                p.deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    receive() external payable {}
}
