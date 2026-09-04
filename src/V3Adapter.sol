// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISweepAdapter} from "./ISweepAdapter.sol";

/// @notice Uniswap SwapRouter02 on Robinhood Chain.
/// @dev    ExactInputSingleParams has NO deadline field. That is the
///         difference between SwapRouter02 and the original SwapRouter,
///         and using the wrong struct reverts every swap with no useful
///         error. Verified against the deployed bytecode at
///         0xCaf681a66D020601342297493863E78C959E5cb2: selector
///         0x04e45aaf (SwapRouter02) is present, 0x414bf389 (old) is not.
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

/// @title V3Adapter
/// @notice Sells one dust token into WETH through Uniswap V3 and hands the
///         proceeds straight back to the caller.
///
/// @dev Covers the Noxa and Pons V1 piles, which are the same shape: fixed
///      supply, one-sided WETH-paired V3 position, locked. Together that is
///      roughly 63,000 tokens and about 75% of everything launched on this
///      chain. Also covers graduated Pons V2 tokens that ended up in a V3
///      pool. Bonding-curve redemption is a different venue and belongs in
///      a different adapter.
///
/// @dev Deliberately ownerless and immutable. The security review flagged
///      the owner key as the main single point of failure in the system;
///      an adapter with no admin surface removes that concern here
///      entirely. There is nothing to upgrade, pause or rescue because
///      there is never anything held.
///
/// @dev Safety properties:
///      1. Holds no balance. `recipient` on the swap is `msg.sender`, so
///         WETH never touches this contract. The Sweeper's before/after
///         balance delta therefore measures the real fill.
///      2. Requires a non-zero `minOut`. An off-chain quote with no
///         on-chain slippage bound is a sandwich waiting to happen, and
///         the security review calls this out explicitly. A token that
///         quotes to zero belongs in the front end's "no route" pile and
///         must never reach this contract.
///      3. Swaps what actually arrived, not what it was asked for, so a
///         fee-on-transfer token cannot make the adapter over-approve.
///      4. Approval is exact and zeroed in the same call. No standing
///         allowance exists between transactions.
contract V3Adapter is ISweepAdapter {
    using SafeERC20 for IERC20;

    IV3SwapRouter public immutable ROUTER;
    address public immutable WETH;

    /// @notice Noxa and Pons V1 both launch on the 1% tier, so this is the
    ///         right default. Pools at 3000 and 500 can exist for tokens
    ///         that actually traded, and for those the front end should
    ///         quote all three and pass the winner in `data`.
    uint24 public constant DEFAULT_FEE = 10_000;

    error ZeroAmount();
    error NoSlippageBound();
    error CannotSellWeth();
    error BadFeeData();

    constructor(address router, address weth) {
        ROUTER = IV3SwapRouter(router);
        WETH = weth;
    }

    /// @param token    Dust token to sell.
    /// @param amountIn Amount the Sweeper approved to this adapter.
    /// @param minOut   Minimum WETH out. Must be non-zero.
    /// @param data     Empty for the 1% default, or `abi.encode(uint24 fee)`
    ///                 to force a tier. Quote 10000 / 3000 / 500 off-chain
    ///                 with QuoterV2 and pass the best one.
    /// @return wethOut WETH delivered to `msg.sender`.
    function sell(address token, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        returns (uint256 wethOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (minOut == 0) revert NoSlippageBound();
        if (token == WETH) revert CannotSellWeth();

        uint24 fee = DEFAULT_FEE;
        if (data.length != 0) {
            if (data.length != 32) revert BadFeeData();
            fee = abi.decode(data, (uint24));
        }

        // The Sweeper approves this adapter, it does not transfer to it.
        // (Its ISweepAdapter doc comment says "funded with", but the code
        // path is forceApprove then call, so the pull is ours to do.)
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        // Trust the balance, not the argument. A fee-on-transfer token
        // delivers less than it was asked for, and approving the larger
        // number is how an adapter ends up trying to spend what it does
        // not have.
        uint256 actual = IERC20(token).balanceOf(address(this));
        if (actual == 0) revert ZeroAmount();

        IERC20(token).forceApprove(address(ROUTER), actual);

        // recipient = msg.sender sends WETH directly back to the Sweeper.
        // amountOutMinimum = minOut is the only thing standing between the
        // user and a sandwich, so it is enforced by the router itself
        // rather than checked here after the fact.
        wethOut = ROUTER.exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: WETH,
                fee: fee,
                recipient: msg.sender,
                amountIn: actual,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(token).forceApprove(address(ROUTER), 0);
    }
}
