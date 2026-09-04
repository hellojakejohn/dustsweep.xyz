import { useAccount, useCapabilities } from 'wagmi';
import { CHAIN_ID } from '../lib/addresses';

/**
 * TEMPORARY DIAGNOSTIC. Delete once the batching question is settled.
 *
 * Only rendered at dustsweep.xyz/?caps -- see App.tsx. It is not linked
 * from anywhere and normal visitors never see it.
 *
 * The question it answers: Robinhood Chain's docs say the chain supports
 * EIP-7702, which would let a plain wallet bundle every Permit2 approval
 * and the sweep itself into ONE confirmation instead of one per token.
 * Whether that actually happens is not up to the chain, it is up to the
 * wallet, and wallets enable it chain by chain. Nothing can be looked up
 * to answer this. The wallet has to be asked, which is what this does
 * (`wallet_getCapabilities`, EIP-5792).
 *
 * If this comes back supported, the write half builds one flow. If it
 * does not, it builds a queue of approvals with honest progress. That is
 * a different screen, so this runs before that gets built, not after.
 */

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v),
      2,
    );
  } catch {
    return String(value);
  }
}

function readVerdict(data: unknown): string {
  if (data === undefined || data === null || typeof data !== 'object') {
    return 'No answer yet.';
  }
  const top = data as Record<string, unknown>;
  const byChain = top[String(CHAIN_ID)];
  const scope = (
    byChain && typeof byChain === 'object' ? byChain : top
  ) as Record<string, unknown>;

  const atomic = (scope.atomic ?? scope.atomicBatch) as
    | Record<string, unknown>
    | undefined;

  if (!atomic || typeof atomic !== 'object') {
    return 'Wallet answered, but claims no batching on this chain. Approvals go one at a time.';
  }

  const status =
    typeof atomic.status === 'string'
      ? atomic.status
      : atomic.supported === true
        ? 'supported'
        : 'unsupported';

  if (status === 'supported' || status === 'ready') {
    return `Batching available (atomic: ${status}). One confirmation is achievable.`;
  }
  return `Batching NOT available (atomic: ${status}). Approvals go one at a time.`;
}

export function CapabilityProbe() {
  const { isConnected, connector } = useAccount();
  const { data, error, isPending } = useCapabilities();

  let body: string;
  if (!isConnected) {
    body = 'Connect a wallet first.';
  } else if (isPending) {
    body = 'Asking the wallet...';
  } else if (error) {
    body =
      'This wallet does not answer the batching question at all, so it has no ' +
      'EIP-5792 support. Approvals go one at a time.\n\n' +
      String(error.message ?? error);
  } else {
    body = `${readVerdict(data)}\n\nRaw:\n${safeJson(data)}`;
  }

  return (
    <section className="mt-6 rounded-lg border border-tan p-3">
      <p className="text-[11px] font-semibold text-tan">
        capability probe -- chain {CHAIN_ID}
        {connector?.name ? ` -- ${connector.name}` : ''}
      </p>
      <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-all text-[10.5px] leading-relaxed text-muted">
        {body}
      </pre>
    </section>
  );
}
