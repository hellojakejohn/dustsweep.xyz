import { EXPLORER } from './addresses';

export type HeldToken = {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** Blockscout's indexed balance. Treated as a hint, not as truth --
   *  it gets re-read on-chain before we quote anything. */
  indexedBalance: bigint;
};

type BlockscoutBalance = {
  value: string | null;
  token: {
    address_hash: string;
    symbol: string | null;
    name: string | null;
    decimals: string | null;
    type: string | null;
  } | null;
};

/**
 * Every ERC-20 the address holds.
 *
 * No API key. Verified working against real wallets on 4 Sep 2026.
 * Blockscout sits behind Cloudflare and rejects clients with no
 * User-Agent, which browsers always send, so this is browser-only.
 */
export async function fetchHeldTokens(
  address: `0x${string}`,
  signal?: AbortSignal,
): Promise<HeldToken[]> {
  const url = `${EXPLORER}/api/v2/addresses/${address}/token-balances`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });

  if (!res.ok) {
    throw new Error(`Blockscout returned ${res.status} scanning ${address}`);
  }

  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error('Blockscout returned an unexpected shape for token balances');
  }

  const out: HeldToken[] = [];
  for (const entry of raw as BlockscoutBalance[]) {
    const token = entry?.token;
    if (!token || token.type !== 'ERC-20') continue;
    if (!token.address_hash?.startsWith('0x')) continue;

    // decimals can be null on a non-conforming token. Without it we
    // cannot display an amount honestly, so skip rather than guess 18.
    const decimals = Number(token.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;

    let indexedBalance: bigint;
    try {
      indexedBalance = BigInt(entry.value ?? '0');
    } catch {
      continue;
    }
    if (indexedBalance <= 0n) continue;

    out.push({
      address: token.address_hash as `0x${string}`,
      symbol: token.symbol?.trim() || '???',
      name: token.name?.trim() || 'Unknown token',
      decimals,
      indexedBalance,
    });
  }
  return out;
}
