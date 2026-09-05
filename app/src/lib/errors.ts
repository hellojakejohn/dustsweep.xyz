import { BaseError, UserRejectedRequestError } from 'viem';

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
