import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  UserRejectedRequestError,
} from 'viem';

/**
 * A rejection is not a failure and must never be shown as one. Somebody
 * who closes a MetaMask prompt on purpose and then reads "Sweep failed"
 * has no way to tell that from the transaction reverting, and on this
 * path the difference is whether their tokens moved.
 */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    const walked = err.walk((e) => e instanceof UserRejectedRequestError);
    if (walked) return true;
  }
  const code = (err as { code?: unknown })?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;

  const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
  return msg.includes('user rejected') || msg.includes('user denied');
}

/**
 * Did the CHAIN reject this, or did the network?
 *
 * The will-it-move probe turns on this distinction. A revert is evidence
 * that a token cannot be moved; a rate limit or a dropped connection is
 * evidence of nothing, and recording one as "stuck" would quietly hide a
 * sweepable token behind a network blip. See lib/willmove.ts.
 */
export function isRevert(err: unknown): boolean {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof ExecutionRevertedError)) return true;
    if (err.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
  }
  // Raw revert data hung off the error by the transport.
  if ((err as { data?: unknown })?.data !== undefined) return true;
  if ((err as { cause?: { data?: unknown } })?.cause?.data !== undefined) return true;

  const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
  return msg.includes('revert');
}

/**
 * A revert carrying no data at all.
 *
 * On the sweep path that shape is almost always Permit2 taking the
 * ERC-1271 branch against a delegate that did not answer. Paired with a
 * `getCode` that comes back non-empty it is specific enough to name.
 *
 * `data` is the DECODED custom error and `raw` the bytes behind it, so
 * both being empty is the whole test. Do NOT also require `reason` to be
 * unset: viem fills it with the literal string "execution reverted" on
 * exactly this shape, which is what made the first version of this
 * function never fire. Checked against a real bare revert on the fork,
 * where the chain is: ContractFunctionExecutionError -> ...RevertedError
 * (data undefined, raw "0x", reason "execution reverted") -> ...
 */
export function isRevertWithoutData(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return false;
  return (
    reverted.data === undefined &&
    (reverted.raw === undefined || reverted.raw === '0x')
  );
}

/** The shortest true sentence about what went wrong. */
export function readableError(err: unknown): string {
  if (err instanceof BaseError) {
    // shortMessage is the decoded revert reason where there is one,
    // including our own custom errors now that they are in the ABI.
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
