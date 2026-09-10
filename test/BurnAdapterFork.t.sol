// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BurnAdapter} from "../src/BurnAdapter.sol";
import {Sweeper, IPermit2} from "../src/Sweeper.sol";
import {IV3SwapRouter} from "../src/V3Adapter.sol";

interface IWETH9Full is IERC20 {
    function deposit() external payable;
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The burn leg, end to end, against the SWEEPER THAT IS ACTUALLY DEPLOYED.
///
/// Every other test in this repo builds a fresh Sweeper in `setUp`. That
/// proves the source compiles into something correct; it does not prove the
/// bytecode sitting at 0x3b0AD850… on 4663 will accept a burn leg, and that
/// contract is the one the front end calls and the one we cannot redeploy.
/// So this test whitelists BurnAdapter on the live Sweeper by pranking its
/// real owner and drives a real Permit2 signature through it.
///
/// It is the gate before the mainnet deploy. The front-end path
/// (`useIncinerate.ts`) still has to be walked by hand with a wallet, but
/// the half that is irreversible if it is wrong is the half this covers.
///
/// Run with:
///   forge test --fork-url rhc --match-path test/BurnAdapterFork.t.sol -vv
contract BurnAdapterForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    /// The live Sweeper, deployed 5 Sep 2026, and the Ledger that owns it.
    address constant LIVE_SWEEPER = 0x3b0AD85011d082C29C76F75F4aAf4674Dd416Cc2;
    address constant LIVE_OWNER = 0x5dCD1D1DD0F797a24Cc509fDd0Df9e8747bBD01b;

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// Real Noxa, WETH-paired on the 1% tier. It HAS a route, which is the
    /// point: buying dust is the cheap way to get a real ERC20 into a test
    /// wallet, and the burn path does not care whether a route exists. The
    /// no-route classification lives in the scanner, not in the contracts.
    address constant NOXA_TOKEN = 0x955b339944CbD4834156366D766C260C80956B44;
    uint24 constant FEE_1PCT = 10_000;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_BATCH_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    Sweeper sweeper;
    BurnAdapter burner;

    /// NOT a famous test key. `0xB0B` and friends are published in a
    /// hundred tutorials, and on a live chain those addresses get claimed:
    /// this one carries code on 4663, which sends Permit2 down its ERC-1271
    /// branch instead of ecrecover. See the note in setUp.
    uint256 userPk = uint256(keccak256("dustsweep.burn.fork.test.v1"));
    address user;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("rhc"));
        user = vm.addr(userPk);

        sweeper = Sweeper(payable(LIVE_SWEEPER));
        assertEq(sweeper.owner(), LIVE_OWNER, "live Sweeper owner moved; stop and re-check");

        // Exactly what script/DeployBurnAdapter.s.sol will do for real,
        // minus the hardware.
        burner = new BurnAdapter();
        vm.prank(LIVE_OWNER);
        sweeper.setAdapter(address(burner), true);
        assertTrue(sweeper.adapterAllowed(address(burner)), "adapter not whitelisted");

        // THE 7702 TRAP, third time in this project. docs/burn-fork-runbook.md
        // section 3 already says to clear delegated code off the test account
        // or "Permit2's ERC-1271 path bites, same as day 5" -- it bit here too.
        //
        // Permit2's SignatureVerification branches on `claimedSigner.code.length`.
        // Any code at all -- a contract, or a 7702 delegation designator -- makes
        // it call `isValidSignature` on the signer instead of running ecrecover,
        // and an account whose delegate does not implement ERC-1271 reverts with
        // no reason data. That is the bare `EvmError: Revert` this test was
        // producing, three tests deep, from inside `_pull`.
        //
        // Unconditional on purpose: cheap, and it makes the test independent of
        // whatever state the signing address happens to have on the fork.
        vm.etch(user, hex"");
        assertEq(user.code.length, 0, "signer carries code; Permit2 will take the 1271 path");

        vm.deal(address(this), 100 ether);
    }

    /// The one that matters. A burn leg fills on the live Sweeper, the
    /// tokens end up at 0xdEaD, and nothing sticks anywhere.
    function test_BurnLegFillsOnLiveSweeper() public {
        uint256 dust = _buyDustFor(user, 0.01 ether);
        assertGt(dust, 0, "did not acquire dust");

        vm.prank(user);
        IERC20(NOXA_TOKEN).approve(PERMIT2, dust);

        uint256 deadBefore = IERC20(NOXA_TOKEN).balanceOf(DEAD);
        uint256 userEthBefore = user.balance;

        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        tokens[0] = NOXA_TOKEN;
        amts[0] = dust;

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 0);
        bytes memory sig = _sign(p);

        // minOut 0 and empty data. BurnAdapter reverts BurnYieldsNothing on
        // anything else, which is the contract-level reason a leg built to
        // sell can never be routed into a burn.
        Sweeper.Leg[] memory legs = new Sweeper.Leg[](1);
        legs[0] = Sweeper.Leg({token: NOXA_TOKEN, adapter: address(burner), minOut: 0, data: ""});

        vm.prank(user);
        uint256 out = sweeper.sweep(p, sig, legs, false, 0);

        // A burn returns nothing, and that must be true all the way out.
        assertEq(out, 0, "a burn paid the user something");
        assertEq(user.balance, userEthBefore, "user balance moved on a burn");

        // The tokens are where they can never come back from.
        assertEq(
            IERC20(NOXA_TOKEN).balanceOf(DEAD) - deadBefore,
            dust,
            "the graveyard did not receive exactly what left"
        );
        assertEq(IERC20(NOXA_TOKEN).balanceOf(user), 0, "user kept some of the burned token");

        // Nothing stuck in the machine.
        assertEq(IERC20(NOXA_TOKEN).balanceOf(address(sweeper)), 0, "sweeper kept the token");
        assertEq(IERC20(NOXA_TOKEN).balanceOf(address(burner)), 0, "adapter kept the token");
        assertEq(
            IERC20(NOXA_TOKEN).allowance(address(sweeper), address(burner)),
            0,
            "allowance left open"
        );
        assertEq(IERC20(WETH).balanceOf(address(sweeper)), 0, "sweeper kept WETH");

        console.log("burned        :", dust);
        console.log("at 0xdEaD now :", IERC20(NOXA_TOKEN).balanceOf(DEAD));
    }

    /// The safety property, from the outside, and it is stronger than it
    /// looks. A leg pointed at the burner but built like a sale reverts
    /// inside BurnAdapter (`BurnYieldsNothing`); the Sweeper catches that
    /// as a failed leg; it was the only leg, so `filled == 0` and the whole
    /// sweep reverts `NothingFilled()`. The tokens are not saved by the
    /// hand-back, they are saved by the transaction never happening.
    function test_NonZeroMinOutRevertsAndBurnsNothing() public {
        uint256 dust = _buyDustFor(user, 0.01 ether);

        vm.prank(user);
        IERC20(NOXA_TOKEN).approve(PERMIT2, dust);

        uint256 deadBefore = IERC20(NOXA_TOKEN).balanceOf(DEAD);

        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        tokens[0] = NOXA_TOKEN;
        amts[0] = dust;

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 0);
        bytes memory sig = _sign(p);

        Sweeper.Leg[] memory legs = new Sweeper.Leg[](1);
        legs[0] = Sweeper.Leg({token: NOXA_TOKEN, adapter: address(burner), minOut: 1, data: ""});

        vm.prank(user);
        vm.expectRevert(Sweeper.NothingFilled.selector);
        sweeper.sweep(p, sig, legs, false, 0);

        assertEq(
            IERC20(NOXA_TOKEN).balanceOf(DEAD), deadBefore, "a minOut != 0 leg burned something"
        );
        assertEq(IERC20(NOXA_TOKEN).balanceOf(user), dust, "the user lost the token");
    }

    /// A burn leg contributes nothing to gross, so it must not move the fee.
    /// This is the assertion that catches a future refactor deciding a burn
    /// should "count" for something.
    function test_BurnMovesNoWethAnywhere() public {
        uint256 dust = _buyDustFor(user, 0.01 ether);

        vm.prank(user);
        IERC20(NOXA_TOKEN).approve(PERMIT2, dust);

        address feeSink = sweeper.feeSink();
        uint256 sinkBefore = IERC20(WETH).balanceOf(feeSink);

        address[] memory tokens = new address[](1);
        uint256[] memory amts = new uint256[](1);
        tokens[0] = NOXA_TOKEN;
        amts[0] = dust;

        IPermit2.PermitBatchTransferFrom memory p = _permit(tokens, amts, 0);
        bytes memory sig = _sign(p);

        Sweeper.Leg[] memory legs = new Sweeper.Leg[](1);
        legs[0] = Sweeper.Leg({token: NOXA_TOKEN, adapter: address(burner), minOut: 0, data: ""});

        vm.prank(user);
        sweeper.sweep(p, sig, legs, false, 0);

        assertEq(IERC20(WETH).balanceOf(feeSink), sinkBefore, "a burn paid a fee");
    }

    // --- helpers ------------------------------------------------------

    /// Returns the balance that ACTUALLY LANDED, not the router's return
    /// value. On a fee-on-transfer token those differ, and permitting more
    /// than the wallet holds makes Permit2 revert inside `_pull` with no
    /// reason data -- which is the same trap `useIncinerate.ts` avoids by
    /// re-reading balances at preflight rather than trusting the scan.
    function _buyDustFor(address to, uint256 wethIn) internal returns (uint256) {
        IWETH9Full(WETH).deposit{value: wethIn}();
        IERC20(WETH).approve(ROUTER, wethIn);
        IV3SwapRouter(ROUTER).exactInputSingle(
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
        return IERC20(NOXA_TOKEN).balanceOf(to);
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
