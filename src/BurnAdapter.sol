// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISweepAdapter} from "./ISweepAdapter.sol";

/// @title BurnAdapter
/// @notice Destroys a dead token instead of selling it, for the two thirds
///         of a typical wallet that has no buyer at any price.
///
/// @dev In a 184-token sample wallet, 125 tokens had no route out. Without
///      this the biggest pile in the app is a dead end: the tool tells you
///      what is worthless and then cannot help you.
///
/// @dev Ownerless and immutable, like V3Adapter. Nothing to upgrade,
///      nothing held, no admin surface.
///
/// @dev THE SAFETY PROPERTY: this adapter requires `minOut == 0`, and
///      V3Adapter requires `minOut != 0`. They are mutually exclusive, so
///      a leg built to sell can never be routed into a burn by mistake,
///      and a leg built to burn can never silently sell. The two failure
///      modes that matter are ruled out by the type of the call rather
///      than by front-end discipline.
///
///      Burning cannot be undone. That is not a reason to avoid it, but
///      it is a reason the UI must confirm it separately from a sweep,
///      with its own wording and its own button.
contract BurnAdapter is ISweepAdapter {
    using SafeERC20 for IERC20;

    /// @dev The conventional graveyard. Not address(0): many ERC20s revert
    ///      on a transfer there, and a burn that reverts is a burn that did
    ///      not happen.
    address public constant GRAVEYARD = 0x000000000000000000000000000000000000dEaD;

    error ZeroAmount();
    error BurnYieldsNothing();

    event Burned(address indexed token, address indexed from, uint256 amount);

    /// @param token    The dead token to destroy.
    /// @param amountIn Amount the Sweeper approved to this adapter.
    /// @param minOut   MUST be zero. Burning returns nothing, so a non-zero
    ///                 value means the caller thought it was selling.
    /// @return Always zero. The Sweeper measures its own WETH delta, so a
    ///         burn contributes nothing to gross, nothing to the fee, and
    ///         nothing to the payout.
    function sell(address token, uint256 amountIn, uint256 minOut, bytes calldata)
        external
        returns (uint256)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (minOut != 0) revert BurnYieldsNothing();

        // Straight from the Sweeper to the graveyard. This adapter never
        // holds the token, not even for one call frame.
        IERC20(token).safeTransferFrom(msg.sender, GRAVEYARD, amountIn);

        emit Burned(token, msg.sender, amountIn);
        return 0;
    }
}
