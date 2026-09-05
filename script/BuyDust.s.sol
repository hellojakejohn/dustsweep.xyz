// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p)
        external payable returns (uint256);
}

/// @notice Builds a dust test fixture: buys small amounts of real dead
///         tokens so the sweeper has something honest to sweep.
///
/// Against a LOCAL FORK (free, recommended first):
///   anvil --fork-url $RHC_RPC_URL --chain-id 4663
///   forge script script/BuyDust.s.sol:BuyDust --rpc-url http://127.0.0.1:8545 \
///     --broadcast --private-key <one of the keys anvil prints>
///
/// Against REAL Robinhood Chain (spends real ETH, needs ~0.01):
///   forge script script/BuyDust.s.sol:BuyDust --rpc-url rhc \
///     --broadcast --account <your-keystore-account>
///
/// Anvil's printed keys are public, published test keys. Never fund them
/// on a real chain and never reuse one anywhere that matters.
///
/// @dev Do not use the script's own sender as a recipient in here. Inside
///      `run()` it is only the broadcaster by coincidence of the flags.
///      Foundry resolves the two separately: `--sender` wins for
///      broadcasting, a sole `--private-key` wins for the script sender,
///      and before Foundry v1.7.0 `--account` set neither, leaving it as
///      the default 0x1804c8AB...1f38. A recipient read from the wrong one
///      sends the fixture to an address nobody holds the key for, and then
///      prints a balance that looks correct because the read is wrong the
///      same way. `vm.readCallers()` inside the broadcast is the real
///      broadcaster. Capture it there: after `stopBroadcast` it reverts to
///      the script sender. See foundry-rs/foundry#8892 and #7255.
contract BuyDust is Script {
    address constant WETH   = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    uint24  constant FEE    = 10_000; // Noxa and Pons V1 both launch on the 1% tier

    function run() external {
        require(block.chainid == 4663, "expected chain 4663 (real or forked)");

        // Real dead tokens, verified WETH-paired with funded pools.
        address[5] memory tokens = [
            0x955b339944CbD4834156366D766C260C80956B44, // Noxa, 0.585 WETH pool
            0x5dDfeB98Cb3b19eefABde82608aE5574049E9C05, // Noxa, 0.169
            0x97133372cC4391A4F6889b4d52387649B76BC7EC, // Pons V1, 0.546
            0x6B2A210E2cd1Bb404C1E208D4f7e0a7d91F68A49, // Pons V1, 0.020
            0x00e608488d2aA0FfeEa12FdEACF487af3141AA4D  // Noxa, 0.047, thinnest
        ];

        // Four normal buys, then one deliberately tiny one so the
        // "costs more than it is worth" pile has a real member.
        uint256[5] memory spend = [
            uint256(0.002 ether), 0.002 ether, 0.002 ether, 0.002 ether, 0.00002 ether
        ];

        uint256 total;
        for (uint256 i; i < spend.length; ++i) total += spend[i];

        vm.startBroadcast();

        // The address actually sending these transactions. See the note above.
        (, address me,) = vm.readCallers();

        IWETH9(WETH).deposit{value: total}();
        IERC20(WETH).approve(ROUTER, total);

        for (uint256 i; i < tokens.length; ++i) {
            // minOut 0 is acceptable here and nowhere else: this is a test
            // fixture on a chain where these pools have no MEV to speak of.
            // The adapter itself refuses minOut == 0 by design.
            try IV3SwapRouter(ROUTER).exactInputSingle(
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: WETH, tokenOut: tokens[i], fee: FEE,
                    recipient: me, amountIn: spend[i],
                    amountOutMinimum: 0, sqrtPriceLimitX96: 0
                })
            ) returns (uint256 out) {
                console.log("bought", out, "of", tokens[i]);
            } catch {
                console.log("FAILED (pool may have moved):", tokens[i]);
            }
        }

        vm.stopBroadcast();

        console.log("");
        console.log("Dust fixture for", me);
        for (uint256 i; i < tokens.length; ++i) {
            console.log(tokens[i], IERC20(tokens[i]).balanceOf(me));
        }
    }
}
