// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Sweeper, IPermit2, ISweepAdapter} from "../src/Sweeper.sol";
import {MockERC20, MockWETH} from "./Sweeper.t.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/* ---------------------------------------------------------------- adapter */

/// @dev Mirrors V3Adapter's conventions: pulls with SafeERC20 (so a token
///      that returns false is a revert, not a phantom fill) and sends WETH
///      straight back to the caller. `GoodAdapter` in Sweeper.t.sol uses a
///      raw transferFrom, which is fine for the happy path but would let a
///      lying token look like a fill.
contract SafeAdapter is ISweepAdapter {
    using SafeERC20 for IERC20;

    MockWETH public immutable W;
    uint256 public payout;

    /// What actually landed here, per token. Fee-on-transfer accounting is
    /// only checkable if the venue records what it really received.
    mapping(address => uint256) public delivered;

    constructor(MockWETH w, uint256 p) {
        W = w;
        payout = p;
    }

    function sell(address token, uint256 amountIn, uint256, bytes calldata)
        external
        returns (uint256)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        delivered[token] = IERC20(token).balanceOf(address(this));
        W.transfer(msg.sender, payout);
        return payout;
    }
}

/* ----------------------------------------------------------------- tokens */

/// Takes a cut of every transfer. The recipient gets less than was asked
/// for, which is the case the Sweeper's balance-delta accounting exists for.
contract FeeOnTransferToken is MockERC20 {
    address public constant FEE_WALLET = address(0xF33);
    uint256 public immutable FEE_BPS;

    constructor(uint256 feeBps) MockERC20("Fee On Transfer", "FOT") {
        FEE_BPS = feeBps;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        balanceOf[FEE_WALLET] += fee;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) public override returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, to, a);
        return true;
    }
}

/// Base for the hostile set. Permit2 must always be able to pull the token
/// in, otherwise the sweep never reaches the code path under test.
abstract contract HostileToken is MockERC20 {
    address internal immutable P2;

    constructor(string memory n, string memory s, address permit2) MockERC20(n, s) {
        P2 = permit2;
    }
}

/// Reverts when anyone but Permit2 pulls it. The classic honeypot: you can
/// buy it, you cannot sell it.
contract RefusesToBeSold is HostileToken {
    constructor(address p) HostileToken("Refuses To Be Sold", "NOPE", p) {}

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (msg.sender != P2) revert("honeypot: no sell");
        return super.transferFrom(f, t, a);
    }
}

/// Worse: it also refuses to leave the Sweeper, so the catch handler's
/// hand-back is itself a reverting call.
contract RefusesToBeSoldOrReturned is HostileToken {
    constructor(address p) HostileToken("No Exit", "TRAP", p) {}

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (msg.sender != P2) revert("trap: no sell");
        return super.transferFrom(f, t, a);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert("trap: no exit");
    }
}

/// Moves nothing and reports success. SafeERC20 in the adapter turns the
/// lie into a revert; without it this is a phantom fill.
contract LiesAboutTransfer is HostileToken {
    constructor(address p) HostileToken("Liar", "LIAR", p) {}

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (msg.sender == P2) return super.transferFrom(f, t, a);
        return false;
    }
}

/// Refuses to be approved. Nothing in the Sweeper's try/catch covers the
/// approve, so this is a separate way to break a leg.
contract RefusesApproval is HostileToken {
    constructor(address p) HostileToken("No Approve", "NOAPP", p) {}

    /// The user's one-time approval to Permit2 must still work, otherwise
    /// the token never reaches the Sweeper. Everything else is refused.
    function approve(address s, uint256 a) public override returns (bool) {
        if (s == P2) return super.approve(s, a);
        revert("no approvals");
    }
}

/// Burns every drop of gas it is given. Models an unbounded loop in a
/// token's transfer hook, which is the cheapest denial-of-service a hostile
/// token has against a batcher.
contract BurnsAllGas is HostileToken {
    uint256 public spin;

    constructor(address p) HostileToken("Gas Burner", "BURN", p) {}

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (msg.sender == P2) return super.transferFrom(f, t, a);
        for (uint256 i;; ++i) {
            spin = uint256(keccak256(abi.encode(spin, i)));
        }
        revert("unreachable");
    }
}

/* ------------------------------------------------------------------ tests */

/// Batch-level tests for the paths CLAUDE.md lists as untested gaps:
/// fee-on-transfer inside a batch, a duplicate token in one permit, tokens
/// broken in several different ways, and a token that is not in the permit.
///
/// Forks 4663 for the real Permit2 only, exactly like Sweeper.t.sol. Every
/// token and venue here is a mock so the numbers are deterministic.
contract SweeperBatchTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_BATCH_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    uint256 constant PAYOUT = 0.01 ether;
    uint256 constant FEE_BPS_NATIVE = 300;

    Sweeper sweeper;
    MockWETH weth;
    SafeAdapter venue;

    MockERC20 tokA;
    MockERC20 tokC;
    MockERC20 untouched;

    uint256 userPk = 0xA11CE;
    address user;
    address feeSink = address(0xFEE);

    uint256 nonce;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("rhc")); // for the real Permit2 only
        user = vm.addr(userPk);

        weth = new MockWETH();
        sweeper = new Sweeper(PERMIT2, address(weth), feeSink);
        venue = new SafeAdapter(weth, PAYOUT);
        sweeper.setAdapter(address(venue), true);

        weth.mint(address(venue), 100 ether);
        vm.deal(address(weth), 100 ether);

        tokA = new MockERC20("A", "A");
        tokC = new MockERC20("C", "C");
        untouched = new MockERC20("Do Not Touch", "SAFE");

        _fund(address(tokA));
        _fund(address(tokC));
        _fund(address(untouched));
    }

    /// Mint to the user and give Permit2 the standing allowance every real
    /// user gives it once.
    function _fund(address token) internal {
        MockERC20(token).mint(user, 1000e18);
        vm.prank(user);
        MockERC20(token).approve(PERMIT2, type(uint256).max);
    }

    /* -------------------------------------------------------- permit2 sig */

    function _permit(address[] memory tokens, uint256[] memory amounts)
        internal
        returns (IPermit2.PermitBatchTransferFrom memory p)
    {
        IPermit2.TokenPermissions[] memory tp = new IPermit2.TokenPermissions[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            tp[i] = IPermit2.TokenPermissions({token: tokens[i], amount: amounts[i]});
        }
        p = IPermit2.PermitBatchTransferFrom({
            permitted: tp,
            nonce: nonce++,
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

    function _legs(address[] memory tokens) internal view returns (Sweeper.Leg[] memory legs) {
        legs = new Sweeper.Leg[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            legs[i] =
                Sweeper.Leg({token: tokens[i], adapter: address(venue), minOut: 1, data: ""});
        }
    }

    function _addrs(address[1] memory a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a[0];
    }

    function _addrs(address[2] memory a) internal pure returns (address[] memory x) {
        x = new address[](2);
        (x[0], x[1]) = (a[0], a[1]);
    }

    function _addrs(address[3] memory a) internal pure returns (address[] memory x) {
        x = new address[](3);
        (x[0], x[1], x[2]) = (a[0], a[1], a[2]);
    }

    function _same(uint256 n, uint256 amount) internal pure returns (uint256[] memory x) {
        x = new uint256[](n);
        for (uint256 i; i < n; ++i) x[i] = amount;
    }

    /// One sweep, ETH payout, no slippage bound on the payout hop.
    function _sweep(address[] memory tokens, uint256[] memory amounts)
        internal
        returns (uint256 out)
    {
        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amounts);
        bytes memory sig = _sign(p);
        vm.prank(user);
        out = sweeper.sweep(p, sig, _legs(tokens), false, 0);
    }

    /// Every assertion that must hold after any sweep, whatever went wrong
    /// inside it.
    function _assertNothingStuck(address[] memory tokens) internal view {
        assertEq(weth.balanceOf(address(sweeper)), 0, "sweeper kept WETH");
        assertEq(address(sweeper).balance, 0, "sweeper kept ETH");
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(
                MockERC20(tokens[i]).allowance(address(sweeper), address(venue)),
                0,
                "allowance left open"
            );
        }
        assertEq(untouched.balanceOf(user), 1000e18, "a token outside the permit MOVED");
        assertEq(untouched.balanceOf(address(sweeper)), 0, "unpermitted token reached sweeper");
    }

    function _net(uint256 legsFilled) internal pure returns (uint256) {
        uint256 gross = legsFilled * PAYOUT;
        return gross - (gross * FEE_BPS_NATIVE) / 10_000;
    }

    /* ------------------------------------------------ (a) fee on transfer */

    /// GAP a. A fee-on-transfer token in a batch with normal ones. The
    /// assertion that matters is not "it did not revert": it is that every
    /// token in the batch is accounted for exactly, including the one that
    /// delivered less than the permit said.
    function test_FeeOnTransferTokenAccountsExactlyInABatch() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1000); // 10%
        _fund(address(fot));

        address[] memory tokens = _addrs([address(tokA), address(fot), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        uint256 ethBefore = user.balance;
        uint256 out = _sweep(tokens, amts);

        // All three legs fill. The FOT leg fills on what arrived, not on
        // what was asked for.
        assertEq(out, _net(3), "net wrong");
        assertEq(user.balance - ethBefore, _net(3), "user ETH wrong");
        assertEq(weth.balanceOf(feeSink), 3 * PAYOUT * FEE_BPS_NATIVE / 10_000, "fee wrong");

        // The user paid 100 of each. Permit2 moved exactly that.
        assertEq(tokA.balanceOf(user), 900e18, "normal token A over/under charged");
        assertEq(tokC.balanceOf(user), 900e18, "normal token C over/under charged");
        assertEq(fot.balanceOf(user), 900e18, "FOT over/under charged");

        // 100 left the user, 10 went to the FOT's fee wallet on the way in,
        // 90 reached the sweeper. 9 more went to the fee wallet on the way
        // to the venue, so the venue holds 81. 19 total in fees.
        assertEq(fot.balanceOf(address(venue)), 81e18, "venue did not get the post-fee amount");
        assertEq(fot.balanceOf(fot.FEE_WALLET()), 19e18, "FOT fee accounting wrong");
        assertEq(fot.balanceOf(address(sweeper)), 0, "sweeper kept FOT residue");

        // Normal tokens are untouched by the FOT's presence.
        assertEq(tokA.balanceOf(address(venue)), 100e18, "normal token A short-delivered");
        assertEq(tokC.balanceOf(address(venue)), 100e18, "normal token C short-delivered");

        _assertNothingStuck(tokens);
    }

    /// A 100% fee token delivers nothing, so the leg is skipped by the
    /// `received == 0` guard before any adapter call. It contributes no
    /// gross and, because there is nothing to hand back, emits no
    /// LegFailed. The rest of the batch is unaffected. Documented rather
    /// than fixed: the tokens are already gone by the time we can see it.
    function test_FeeOnTransferTokenThatEatsEverythingIsSkipped() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(10_000); // 100%
        _fund(address(fot));

        address[] memory tokens = _addrs([address(tokA), address(fot), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        uint256 out = _sweep(tokens, amts);

        assertEq(out, _net(2), "the eaten leg must not contribute gross");
        assertEq(fot.balanceOf(address(sweeper)), 0);
        assertEq(fot.balanceOf(address(venue)), 0, "venue was called for a zero balance");
        assertEq(fot.balanceOf(fot.FEE_WALLET()), 100e18, "the token took the lot");
        _assertNothingStuck(tokens);
    }

    /* ------------------------------------------------ (b) duplicate token */

    /// GAP b. The same token twice in one permit. Permit2 pulls both
    /// amounts, the first leg sells the combined balance and the second
    /// finds zero and skips. Nothing is lost and nothing is stranded.
    function test_DuplicateTokenInOnePermitLosesNothing() public {
        address[] memory tokens = _addrs([address(tokA), address(tokA)]);
        uint256[] memory amts = new uint256[](2);
        amts[0] = 100e18;
        amts[1] = 200e18;

        uint256 out = _sweep(tokens, amts);

        // One fill, not two: the second leg has nothing left to sell.
        assertEq(out, _net(1), "duplicate leg double-counted gross");

        // Everything the user signed for moved exactly once.
        assertEq(tokA.balanceOf(user), 700e18, "user charged the wrong amount");
        assertEq(tokA.balanceOf(address(venue)), 300e18, "venue did not receive both amounts");
        assertEq(tokA.balanceOf(address(sweeper)), 0, "sweeper stranded the duplicate");

        _assertNothingStuck(tokens);
    }

    /* ------------------------------------------------- (c) broken tokens  */

    /// GAP c.1. Reverts when the adapter tries to pull it. The catch hands
    /// it back and the rest of the batch fills.
    function test_BatchSurvivesATokenThatRevertsOnSale() public {
        RefusesToBeSold nope = new RefusesToBeSold(PERMIT2);
        _fund(address(nope));

        address[] memory tokens = _addrs([address(tokA), address(nope), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        uint256 out = _sweep(tokens, amts);

        assertEq(out, _net(2), "good legs did not fill");
        assertEq(nope.balanceOf(user), 1000e18, "honeypot was not handed back in full");
        assertEq(nope.balanceOf(address(sweeper)), 0, "sweeper kept the honeypot");
        _assertNothingStuck(tokens);
    }

    /// GAP c.2. Returns false instead of reverting. SafeERC20 in the
    /// adapter turns that into a revert, so it lands in the same catch and
    /// cannot produce a phantom fill.
    function test_BatchSurvivesATokenThatReturnsFalse() public {
        LiesAboutTransfer liar = new LiesAboutTransfer(PERMIT2);
        _fund(address(liar));

        address[] memory tokens = _addrs([address(tokA), address(liar), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        uint256 out = _sweep(tokens, amts);

        assertEq(out, _net(2), "a lying token produced a phantom fill");
        assertEq(liar.balanceOf(user), 1000e18, "lying token not handed back");
        assertEq(liar.balanceOf(address(venue)), 0, "venue thinks it was paid");
        _assertNothingStuck(tokens);
    }

    /// GAP c.3. Refuses to be approved. The approve sits outside the
    /// try/catch around the adapter, so this is its own failure path.
    function test_BatchSurvivesATokenThatRefusesApproval() public {
        RefusesApproval noapp = new RefusesApproval(PERMIT2);
        _fund(address(noapp));

        address[] memory tokens = _addrs([address(tokA), address(noapp), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        uint256 out = _sweep(tokens, amts);

        assertEq(out, _net(2), "good legs did not fill");
        assertEq(noapp.balanceOf(user), 1000e18, "unapprovable token not handed back");
        assertEq(noapp.balanceOf(address(sweeper)), 0, "sweeper kept it");
        _assertNothingStuck(tokens);
    }

    /// GAP c.4. Cannot be sold AND cannot be handed back. The catch's own
    /// transfer reverts, which is the one place a try/catch can still take
    /// the whole batch down with it.
    ///
    /// Expected behaviour: the batch survives, the good legs pay out, and
    /// the token is left in the Sweeper with a LegStranded event. The
    /// alternative -- reverting -- costs the user their gas and every other
    /// leg for the sake of a token that is, by construction, untransferable
    /// and therefore worthless.
    function test_BatchSurvivesATokenThatCannotEvenBeHandedBack() public {
        RefusesToBeSoldOrReturned trap = new RefusesToBeSoldOrReturned(PERMIT2);
        _fund(address(trap));

        address[] memory tokens = _addrs([address(tokA), address(trap), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        vm.expectEmit(true, true, false, true, address(sweeper));
        emit Sweeper.LegStranded(user, address(trap), 100e18);

        uint256 out = _sweep(tokens, amts);

        assertEq(out, _net(2), "one no-exit token took down the batch");
        assertEq(trap.balanceOf(address(sweeper)), 100e18, "stranded amount wrong");
        assertEq(tokA.balanceOf(address(venue)), 100e18, "leg before the trap did not fill");
        assertEq(tokC.balanceOf(address(venue)), 100e18, "leg after the trap did not fill");
        _assertNothingStuck(tokens);
    }

    /// GAP c.5. Burns every drop of gas it is handed.
    ///
    /// The 63/64 rule means the outer frame keeps 1/64 of what it had, so
    /// the batch survives ONLY if the caller supplied roughly 64x what the
    /// remaining legs need. There is no per-leg gas cap, so this is a real
    /// griefing property, not a hypothetical. The test pins both halves:
    /// enough gas and it completes, too little and it does not.
    function test_BatchSurvivesAGasBurnerGivenEnoughGas() public {
        BurnsAllGas burner = new BurnsAllGas(PERMIT2);
        _fund(address(burner));

        address[] memory tokens = _addrs([address(tokA), address(burner), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts);
        bytes memory sig = _sign(p);

        vm.prank(user);
        uint256 out = sweeper.sweep{gas: 30_000_000}(p, sig, _legs(tokens), false, 0);

        assertEq(out, _net(2), "gas burner stopped the other legs filling");
        assertEq(burner.balanceOf(user), 1000e18, "gas burner not handed back");
        _assertNothingStuck(tokens);
    }

    /// The other half of the same property, stated so nobody mistakes the
    /// test above for a claim that gas griefing is solved. Starve the call
    /// and the whole sweep dies.
    function test_GasBurnerKillsTheBatchWhenGasIsTight() public {
        BurnsAllGas burner = new BurnsAllGas(PERMIT2);
        _fund(address(burner));

        address[] memory tokens = _addrs([address(tokA), address(burner), address(tokC)]);
        uint256[] memory amts = _same(3, 100e18);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts);
        bytes memory sig = _sign(p);

        vm.prank(user);
        vm.expectRevert();
        sweeper.sweep{gas: 900_000}(p, sig, _legs(tokens), false, 0);
    }

    /* --------------------------------------- (d) token not in the permit */

    /// GAP d. `test_TokenOutsideThePermitIsUntouched` in Sweeper.t.sol
    /// covers the single-leg happy path. This is the version that matters:
    /// the batch is full of hostile tokens, several legs are in the catch
    /// handler, and the token the user did not sign for still does not move
    /// even though Permit2 holds an unlimited allowance on it.
    function test_UnpermittedTokenIsUntouchedEvenWhenLegsFail() public {
        RefusesToBeSoldOrReturned trap = new RefusesToBeSoldOrReturned(PERMIT2);
        LiesAboutTransfer liar = new LiesAboutTransfer(PERMIT2);
        _fund(address(trap));
        _fund(address(liar));

        assertEq(
            untouched.allowance(user, PERMIT2),
            type(uint256).max,
            "precondition: Permit2 must be able to move it"
        );

        address[] memory tokens = _addrs([address(trap), address(tokA), address(liar)]);
        uint256[] memory amts = _same(3, 100e18);

        _sweep(tokens, amts);

        assertEq(untouched.balanceOf(user), 1000e18, "a token outside the permit MOVED");
        assertEq(untouched.balanceOf(address(sweeper)), 0);
        assertEq(untouched.balanceOf(address(venue)), 0);
        assertEq(untouched.allowance(address(sweeper), address(venue)), 0);
    }

    /// And the leg-level guard: a leg cannot name a token the permit does
    /// not, even when the rest of the batch lines up.
    function test_LegNamingAnUnpermittedTokenRevertsTheWholeSweep() public {
        address[] memory tokens = _addrs([address(tokA), address(tokC)]);
        uint256[] memory amts = _same(2, 100e18);

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts);
        bytes memory sig = _sign(p);

        Sweeper.Leg[] memory legs = _legs(tokens);
        legs[1].token = address(untouched);

        vm.prank(user);
        vm.expectRevert(Sweeper.LengthMismatch.selector);
        sweeper.sweep(p, sig, legs, false, 0);

        assertEq(untouched.balanceOf(user), 1000e18);
    }
}
