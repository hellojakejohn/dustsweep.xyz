// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Uniswap SwapRouter02 on Robinhood Chain, at
///         0xCaf681a66D020601342297493863E78C959E5cb2.
///
/// @dev ExactInputSingleParams has NO deadline field. That is the difference
///      between SwapRouter02 and the original SwapRouter, and using the wrong
///      struct reverts every swap with no useful error. Verified against the
///      deployed bytecode: selector 0x04e45aaf (SwapRouter02) is present,
///      0x414bf389 (old) is not.
///
/// @dev Declared once, here. It was previously declared in both
///      `V3Adapter.sol` and `BuybackBurner.sol`; the two copies agreed, but
///      the compiler cannot tell you when they stop agreeing, and a struct
///      whose field order drifts is a silent wrong-calldata bug rather than
///      a build failure. Same reasoning as `ISweepAdapter`.
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
