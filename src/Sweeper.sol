// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISweepAdapter} from "./ISweepAdapter.sol";

interface IWETH9 is IERC20 {
    function withdraw(uint256) external;
}

interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }

    function permitTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @title Sweeper
/// @notice Sells a batch of dust tokens in a single transaction and returns
///         the proceeds as ETH, or as a payout token if the caller opts in.
/// @dev    Safety model, in order of importance:
///         1. Holds no balance between transactions, with one stated
///            exception: a token that refuses every transfer out cannot be
///            handed back after a failed leg and is left here, with a
///            `LegStranded` event. See `_returnOrStrand`.
///         2. Moves only what the caller signed for in the Permit2 batch.
///            A token absent from that batch cannot be touched, which is
///            what makes "it might sell my WBTC" structurally impossible
///            rather than merely unlikely.
///         3. Never holds a standing allowance on any adapter. Approvals are
///            set to an exact amount and zeroed in the same call.
///         4. Refuses any leg worth more than `maxLegValueWei`. A "dust"
///            token quoting above the ceiling means a bad quote or a
///            manipulated pool, so stop rather than proceed.
contract Sweeper is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    // WETH is declared as IWETH9, which is a *different* type to Solidity
    // even though it inherits IERC20. Without this second directive the
    // SafeERC20 helpers are not attached to it and `WETH.safeTransfer`
    // does not resolve.
    using SafeERC20 for IWETH9;

    IPermit2 public immutable PERMIT2;
    IWETH9 public immutable WETH;

    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS = 500; // 5%, hard ceiling

    uint256 public feeBpsNative = 300; // 3% when paid out in ETH
    uint256 public feeBpsPayout = 100; // 1% when paid out in the payout token
    uint256 public maxLegValueWei = 0.5 ether; // launch value. raise once it has run.

    address public feeSink;
    address public payoutToken;
    address public payoutAdapter;

    mapping(address => bool) public adapterAllowed;

    struct Leg {
        address token;
        address adapter;
        uint256 minOut;
        bytes data;
    }

    event Swept(
        address indexed user,
        uint256 legsAttempted,
        uint256 legsFilled,
        uint256 grossWeth,
        uint256 feeWeth,
        uint256 userOut,
        bool paidInPayoutToken
    );
    event LegFailed(address indexed user, address indexed token, bytes reason);
    // A token that cannot be handed back is left here on purpose. It is
    // the only place the contract knowingly keeps a balance, so it has to
    // be visible from outside rather than inferred from a balance query.
    event LegStranded(address indexed user, address indexed token, uint256 amount);
    event AdapterSet(address indexed adapter, bool allowed);
    // An owner who can move the fees or the value ceiling silently is not
    // observable by anyone. If the pitch is "public source", the knobs have
    // to be watchable too.
    event FeesSet(uint256 nativeBps, uint256 payoutBps);
    event PayoutSet(address indexed token, address indexed adapter);
    event FeeSinkSet(address indexed sink);
    event MaxLegValueSet(uint256 maxWei);

    error NoLegs();
    error LengthMismatch();
    error AdapterNotAllowed(address adapter);
    error LegValueTooHigh(address token, uint256 valueWei);
    error NothingFilled();
    error FeeTooHigh();
    error PayoutUnavailable();
    error EthTransferFailed();
    error ZeroAddress();

    constructor(address permit2, address weth, address feeSink_) Ownable(msg.sender) {
        // A zero feeSink makes every sweep with a non-zero fee revert on the
        // transfer, bricking the contract on a one-line deploy typo.
        if (permit2 == address(0) || weth == address(0) || feeSink_ == address(0)) {
            revert ZeroAddress();
        }
        PERMIT2 = IPermit2(permit2);
        WETH = IWETH9(weth);
        feeSink = feeSink_;
    }

    // --- core ---------------------------------------------------------

    /// @param permit      Permit2 batch the user signed. This list is the
    ///                    authoritative set of tokens that may be moved.
    /// @param signature   Signature over `permit`.
    /// @param legs        One entry per permitted token, same order.
    /// @param wantPayout  True to receive `payoutToken`, false for ETH.
    /// @param minPayout   Slippage bound on the payout-token hop.
    function sweep(
        IPermit2.PermitBatchTransferFrom calldata permit,
        bytes calldata signature,
        Leg[] calldata legs,
        bool wantPayout,
        uint256 minPayout
    ) external nonReentrant returns (uint256 userOut) {
        uint256 n = legs.length;
        if (n == 0) revert NoLegs();
        if (permit.permitted.length != n) revert LengthMismatch();

        _pull(permit, signature, legs);

        (uint256 gross, uint256 filled) = _sellAll(legs);
        if (filled == 0) revert NothingFilled();

        uint256 fee = (gross * (wantPayout ? feeBpsPayout : feeBpsNative)) / FEE_DENOMINATOR;
        if (fee != 0) WETH.safeTransfer(feeSink, fee);

        userOut = _payout(gross - fee, wantPayout, minPayout);

        emit Swept(msg.sender, n, filled, gross, fee, userOut, wantPayout);
    }

    /// @dev Validates every leg against the signed permit, then pulls all
    ///      permitted tokens in one shot. Amounts come from the permit, never
    ///      from calldata, so a malicious front end cannot inflate a transfer.
    function _pull(
        IPermit2.PermitBatchTransferFrom calldata permit,
        bytes calldata signature,
        Leg[] calldata legs
    ) private {
        uint256 n = legs.length;
        IPermit2.SignatureTransferDetails[] memory details =
            new IPermit2.SignatureTransferDetails[](n);
        for (uint256 i; i < n; ++i) {
            if (permit.permitted[i].token != legs[i].token) revert LengthMismatch();
            if (!adapterAllowed[legs[i].adapter]) revert AdapterNotAllowed(legs[i].adapter);
            details[i] = IPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted[i].amount
            });
        }
        PERMIT2.permitTransferFrom(permit, details, msg.sender, signature);
    }

    /// @dev One hostile or illiquid token must not strand the batch. Every
    ///      call into the token is therefore allowed to fail the leg and only
    ///      the leg: the approve, the sale, and the hand-back. Isolating the
    ///      sale alone is not enough, because a token that reverts on
    ///      `approve` never reaches the try, and one that reverts on
    ///      `transfer` reverts inside the catch.
    function _sellAll(Leg[] calldata legs) private returns (uint256 gross, uint256 filled) {
        uint256 n = legs.length;
        for (uint256 i; i < n; ++i) {
            Leg calldata leg = legs[i];

            // Measure what actually landed. Fee-on-transfer tokens deliver
            // less than the permit says, and trusting the permit amount here
            // is how batch sweepers end up insolvent mid-loop.
            uint256 received = IERC20(leg.token).balanceOf(address(this));
            if (received == 0) continue;

            // The approve is a call into the token, so a hostile token can
            // revert here just as easily as in the swap. It has to fail the
            // leg, not the batch.
            (bool approved, bytes memory approveErr) =
                _tryApprove(leg.token, leg.adapter, received);
            if (!approved) {
                emit LegFailed(msg.sender, leg.token, approveErr);
                _returnOrStrand(leg.token, received);
                continue;
            }

            uint256 before = WETH.balanceOf(address(this));

            try ISweepAdapter(leg.adapter).sell(leg.token, received, leg.minOut, leg.data) {
                uint256 out = WETH.balanceOf(address(this)) - before;
                if (out > maxLegValueWei) revert LegValueTooHigh(leg.token, out);
                gross += out;
                unchecked { ++filled; }
            } catch (bytes memory reason) {
                emit LegFailed(msg.sender, leg.token, reason);
                _returnOrStrand(leg.token, received);
            }
            // Best effort, and the return is ignored on purpose. A token
            // that refuses `approve(0)` leaves a standing allowance to a
            // whitelisted adapter for a balance this contract no longer
            // holds, which is worth strictly less than reverting the batch
            // over it.
            _tryApprove(leg.token, leg.adapter, 0);
        }
    }

    /// @dev Hand a failed leg's token back. A honeypot that refuses every
    ///      transfer out will revert here too, and a revert inside the catch
    ///      handler propagates: it would take down the whole batch, which is
    ///      exactly what the try/catch exists to prevent. So the hand-back is
    ///      itself allowed to fail. The token stays here and the event says
    ///      so.
    ///
    ///      The trade is deliberate. Losing an untransferable token is losing
    ///      something that has no buyer and cannot be moved by its holder
    ///      either. Reverting instead would cost the user their gas and every
    ///      other leg in the batch to protect it.
    function _returnOrStrand(address token, uint256 amount) private {
        (bool ok,) = _tryCall(token, abi.encodeCall(IERC20.transfer, (msg.sender, amount)));
        if (!ok) emit LegStranded(msg.sender, token, amount);
    }

    /// @dev `SafeERC20.forceApprove` reverts on a token that refuses to be
    ///      approved. This is the same logic -- set it, and on failure clear
    ///      to zero first for the tokens that demand that -- with the revert
    ///      turned into a return value.
    function _tryApprove(address token, address spender, uint256 value)
        private
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = _tryCall(token, abi.encodeCall(IERC20.approve, (spender, value)));
        if (!ok && value != 0) {
            (bool cleared,) = _tryCall(token, abi.encodeCall(IERC20.approve, (spender, 0)));
            if (cleared) {
                (ok, ret) = _tryCall(token, abi.encodeCall(IERC20.approve, (spender, value)));
            }
        }
    }

    /// @dev SafeERC20's return-data handling without the revert. Callers only
    ///      reach this for a token that has already answered `balanceOf` with
    ///      a non-zero number, so there is code at the address and an empty
    ///      return is the usual non-standard-ERC20 success, not a call into
    ///      the void.
    function _tryCall(address token, bytes memory data)
        private
        returns (bool ok, bytes memory ret)
    {
        bool called;
        (called, ret) = token.call(data);
        ok = called && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    /// @dev Deliberately NOT wrapped in try/catch. If the payout hop fails the
    ///      whole sweep reverts and the user keeps their tokens.
    function _payout(uint256 net, bool wantPayout, uint256 minPayout)
        private
        returns (uint256 userOut)
    {
        if (wantPayout) {
            address pt = payoutToken;
            address pa = payoutAdapter;
            if (pt == address(0) || pa == address(0)) revert PayoutUnavailable();
            WETH.safeTransfer(pa, net);
            userOut = ISweepAdapter(pa).sell(address(WETH), net, minPayout, "");
            IERC20(pt).safeTransfer(msg.sender, userOut);
        } else {
            WETH.withdraw(net);
            userOut = net;
            (bool ok,) = msg.sender.call{value: net}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        adapterAllowed[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function setFees(uint256 native_, uint256 payout_) external onlyOwner {
        if (native_ > MAX_FEE_BPS || payout_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBpsNative = native_;
        feeBpsPayout = payout_;
        emit FeesSet(native_, payout_);
    }

    function setPayout(address token, address adapter) external onlyOwner {
        payoutToken = token;
        payoutAdapter = adapter;
        emit PayoutSet(token, adapter);
    }

    function setFeeSink(address sink) external onlyOwner {
        if (sink == address(0)) revert ZeroAddress();
        feeSink = sink;
        emit FeeSinkSet(sink);
    }

    function setMaxLegValue(uint256 wei_) external onlyOwner {
        maxLegValueWei = wei_;
        emit MaxLegValueSet(wei_);
    }

    receive() external payable {}
}
