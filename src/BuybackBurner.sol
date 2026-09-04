// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p)
        external payable returns (uint256);
}

/// @title BuybackBurner
/// @notice Receives sweep fees in WETH, buys SWEEP with them, and sends the
///         SWEEP straight to the graveyard.
///
/// @dev DEPLOY THIS AFTER SWEEP EXISTS. The token address is immutable, set
///      once in the constructor. That is deliberate: it means this contract
///      can never be pointed at a different token, not by Jake, not by
///      anyone. Then `Sweeper.setFeeSink(thisAddress)` and fees flow here
///      automatically.
///
/// @dev The trust properties, which are the entire point:
///
///      1. **No owner.** There is no withdraw, no rescue, no admin. WETH
///         that arrives here can only ever leave as a SWEEP burn. Nobody
///         can drain it, including whoever deployed it.
///      2. **SWEEP is immutable.** It can only ever buy the one token.
///      3. **The swap sends SWEEP directly to the graveyard.** This
///         contract never holds SWEEP, not even for one call frame, so
///         there is no moment at which it could be diverted.
///      4. **Anyone can call `burn()`.** Not just the deployer. So this
///         cannot quietly stop happening because someone got busy or
///         changed their mind. If fees are sitting here, any holder can
///         force the burn themselves.
///
///      Together those mean the promise is enforced by the code rather
///      than by anyone's continued good intentions. That is worth more
///      than the burn itself.
///
/// @dev BE HONEST ABOUT THE SIZE OF THIS. At realistic early volume a burn
///      is a fraction of a percent of supply. It does not move the price
///      and anyone can check the arithmetic. What it proves is that the
///      revenue is real and where it goes. Sell it as a receipt, never as
///      a pump.
contract BuybackBurner {
    using SafeERC20 for IERC20;

    address public constant GRAVEYARD = 0x000000000000000000000000000000000000dEaD;

    IV3SwapRouter public immutable ROUTER;
    address public immutable WETH;
    address public immutable SWEEP;
    uint24 public immutable POOL_FEE;

    /// @notice Minimum gap between burns. Bounds how often a caller can
    ///         force a small, easily-sandwiched buy.
    uint256 public constant COOLDOWN = 1 hours;

    uint256 public lastBurn;
    uint256 public totalWethSpent;
    uint256 public totalSweepBurned;

    error NothingToBurn();
    error NoSlippageBound();
    error TooSoon(uint256 readyAt);
    error ZeroAddress();

    event BoughtAndBurned(
        address indexed caller, uint256 wethIn, uint256 sweepBurned, uint256 totalBurned
    );

    constructor(address router, address weth, address sweep, uint24 poolFee) {
        if (router == address(0) || weth == address(0) || sweep == address(0)) {
            revert ZeroAddress();
        }
        ROUTER = IV3SwapRouter(router);
        WETH = weth;
        SWEEP = sweep;
        POOL_FEE = poolFee;
    }

    /// @notice Spend every WETH held here on SWEEP and burn it.
    /// @param minOut Minimum SWEEP out. Must be non-zero: an unbounded swap
    ///               here is free money for a sandwicher, and while it
    ///               steals from nobody in particular it makes the burn
    ///               smaller for no reason. Quote it off-chain first.
    function burn(uint256 minOut) external returns (uint256 burned) {
        if (minOut == 0) revert NoSlippageBound();

        uint256 readyAt = lastBurn + COOLDOWN;
        if (block.timestamp < readyAt) revert TooSoon(readyAt);

        uint256 amountIn = IERC20(WETH).balanceOf(address(this));
        if (amountIn == 0) revert NothingToBurn();

        lastBurn = block.timestamp;

        IERC20(WETH).forceApprove(address(ROUTER), amountIn);

        // recipient is the graveyard, so the SWEEP never passes through
        // this contract and cannot be diverted mid-flight.
        burned = ROUTER.exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: SWEEP,
                fee: POOL_FEE,
                recipient: GRAVEYARD,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(WETH).forceApprove(address(ROUTER), 0);

        totalWethSpent += amountIn;
        totalSweepBurned += burned;

        emit BoughtAndBurned(msg.sender, amountIn, burned, totalSweepBurned);
    }

    /// @notice What a caller would spend on the next burn. For the UI, so
    ///         the pending amount is public before anyone triggers it.
    function pending() external view returns (uint256 weth, uint256 readyAt) {
        return (IERC20(WETH).balanceOf(address(this)), lastBurn + COOLDOWN);
    }
}
