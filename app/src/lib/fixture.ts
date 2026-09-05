import { erc20Abi, type PublicClient } from 'viem';
import type { HeldToken } from './blockscout';

/**
 * Fork-only token discovery.
 *
 * The read half lists a wallet's tokens through Blockscout, which
 * indexes MAINNET. It is the one step that does not go through
 * `VITE_RPC_URL`, and on an anvil fork that makes it useless: dust
 * bought on the fork was never mined on the chain Blockscout watches,
 * so the fixture wallet comes back empty and the app correctly reports
 * "No dust found." Everything downstream of discovery already reads
 * from the client, so the fork was never the problem. The list was.
 *
 * On a fork you supply the list yourself:
 *
 *   VITE_HELD_TOKENS=0xabc...,0xdef... npm run dev
 *
 * Unset, this file does nothing and Blockscout stays the only path.
 * That is the production path and it is deliberately untouched.
 */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export const FIXTURE_TOKENS: `0x${string}`[] = (
  import.meta.env.VITE_HELD_TOKENS ?? ''
)
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is `0x${string}` => ADDR_RE.test(s));

export const FIXTURE_IS_ON = FIXTURE_TOKENS.length > 0;

/**
 * Returns the same shape Blockscout's path returns, read off whatever
 * chain the client points at.
 *
 * A token whose `decimals` or `balanceOf` will not read is dropped
 * rather than defaulted. Assuming 18 here would put a wrong amount on
 * screen next to a price, which is the specific lie this tool exists
 * not to tell.
 */
export async function fetchFixtureTokens(
  client: PublicClient,
  owner: `0x${string}`,
  tokens: `0x${string}`[] = FIXTURE_TOKENS,
): Promise<HeldToken[]> {
  if (tokens.length === 0) return [];

  const results = await client.multicall({
    allowFailure: true,
    batchSize: 0,
    contracts: tokens.flatMap((address) => [
      { address, abi: erc20Abi, functionName: 'symbol' as const },
      { address, abi: erc20Abi, functionName: 'name' as const },
      { address, abi: erc20Abi, functionName: 'decimals' as const },
      {
        address,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [owner] as const,
      },
    ]),
  });

  const out: HeldToken[] = [];

  tokens.forEach((address, i) => {
    const symbol = results[i * 4];
    const name = results[i * 4 + 1];
    const decimals = results[i * 4 + 2];
    const balance = results[i * 4 + 3];

    if (decimals?.status !== 'success' || balance?.status !== 'success') return;

    const dec = Number(decimals.result);
    if (!Number.isInteger(dec) || dec < 0 || dec > 36) return;

    const bal = balance.result as bigint;
    if (bal <= 0n) return;

    out.push({
      address,
      symbol: symbol?.status === 'success' ? String(symbol.result).trim() || '???' : '???',
      name: name?.status === 'success' ? String(name.result).trim() || 'Unknown token' : 'Unknown token',
      decimals: dec,
      indexedBalance: bal,
    });
  });

  return out;
}
