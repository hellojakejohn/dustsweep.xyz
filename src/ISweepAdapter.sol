// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice One route out of one venue. Single source of truth: this interface
///         was previously declared twice, in Sweeper.sol and V3Adapter.sol,
///         and the two copies had already drifted apart on who transfers.
///         The compiler cannot catch that, so there is now only one.
///
/// @dev The core sets an exact-amount approval for `amountIn` of `token`
///      before calling, so the adapter must PULL with transferFrom. The
///      payout leg is the exception: it is pre-funded by transfer. The
///      adapter must send WETH back to `msg.sender`. Reverts are expected
///      and are caught by the core.
interface ISweepAdapter {
    function sell(address token, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        returns (uint256 wethOut);
}
