import { CHAIN_ID } from './addresses';

/**
 * The seam for one-click sweeping, held open on purpose.
 *
 * Robinhood Chain's docs claim EIP-7702, which would let a plain EOA
 * bundle every approval and the sweep into ONE confirmation. The wallet
 * decides that, not the chain, and on 4 Sep 2026 MetaMask answered
 * `wallet_getCapabilities` with seven chains, all `atomic: ready`, and
 * 4663 was not among them. So the flow below it is a queue: N approvals,
 * one signature, one sweep. That is the floor and it is not a bug.
 *
 * MetaMask turns 7702 on chain by chain and this one is nine weeks old,
 * so it will probably flip. When it does, the change is here and in one
 * branch of `useSweep`:
 *
 *   1. `atomicStatus()` starts returning 'ready' on its own. It is a live
 *      read of the connected wallet, not a constant, so nothing needs
 *      editing to notice.
 *   2. In `useSweep.run()`, replace the `for` loop over `steps` with a
 *      single `useSendCalls({ calls: steps.map(approveTx) })`. Everything
 *      either side of it -- the plan, the re-quote, the permit, the
 *      receipt parse -- is unchanged, because none of it knows how the
 *      approvals were sent.
 *
 * Nothing here fires the batched path yet. A branch that has never run
 * against a real wallet is not something to switch on from a doc comment,
 * and `ATOMIC_READY` is what gates it when Jake has clicked through it.
 */

export type AtomicStatus = 'ready' | 'supported' | 'unsupported' | 'unknown';

/**
 * Set to true only after the batched path has been clicked through
 * against a wallet that reports 4663 as atomic. Until then the queue
 * runs even if the wallet says it could do better, and the UI says so.
 */
export const ATOMIC_READY = false;

/**
 * Reads the EIP-5792 capability object wagmi hands back.
 *
 * Shape varies by wallet: some key by chain id, some answer flat, and
 * the field has been called both `atomic` and `atomicBatch` across
 * drafts. Absent means unsupported -- a wallet that enumerates what it
 * will batch and leaves 4663 out has answered the question.
 */
export function atomicStatus(
  capabilities: unknown,
  chainId: number = CHAIN_ID,
): AtomicStatus {
  if (!capabilities || typeof capabilities !== 'object') return 'unknown';

  const top = capabilities as Record<string, unknown>;
  const byChain = top[String(chainId)];
  const scope = (byChain && typeof byChain === 'object' ? byChain : top) as Record<
    string,
    unknown
  >;

  // If the wallet keyed by chain and ours is not one of the keys, it does
  // not batch here. Falling through to the flat read would let another
  // chain's answer stand in for this one.
  if (!byChain && Object.keys(top).some((k) => /^\d+$/.test(k))) return 'unsupported';

  const atomic = (scope.atomic ?? scope.atomicBatch) as Record<string, unknown> | undefined;
  if (!atomic || typeof atomic !== 'object') return 'unsupported';

  if (typeof atomic.status === 'string') {
    return atomic.status === 'ready' || atomic.status === 'supported'
      ? (atomic.status as AtomicStatus)
      : 'unsupported';
  }
  return atomic.supported === true ? 'supported' : 'unsupported';
}

export function canBatchAtomically(status: AtomicStatus): boolean {
  return ATOMIC_READY && (status === 'ready' || status === 'supported');
}
