import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type PublicClient,
} from 'viem';
import { isRevert } from './errors';

/**
 * The BOW problem: will this token even leave the wallet?
 *
 * BOW (0x9b1C8C5CBC20316Fc311F00a6248b6bCf950ed8a) quotes perfectly well
 * and cannot be transferred to anything except its own Uniswap pool.
 * Verified 5 Sep 2026 by eth_call against mainnet with a balance state
 * override:
 *
 *   transfer(random EOA, balance)  ->  revert "Transfers locked until graduation"
 *   transfer(BOW's own pool, bal)  ->  true
 *
 * The pool itself is exempt from the lock, which is why quoting sees
 * nothing wrong: the Quoter simulates a swap INTO the pool, the one
 * recipient the token allows.
 *
 * Why this is worth its own pass rather than being left to the contract:
 * `Sweeper.sweep` pulls every token in one `Permit2.permitTransferFrom`,
 * and that pull is OUTSIDE the per-leg try/catch. So a BOW-class token
 * does not fail its own leg, it reverts the ENTIRE sweep, at simulate
 * time, after the user has already paid for N approvals. Almost nobody
 * sweeps twice, so there is no second visit in which to recover that.
 *
 * A plain `transfer` needs no approval, so this runs before any wallet
 * prompt, alongside the quote step, and costs the user nothing.
 */
export const WILL_NOT_MOVE_REASON =
  'Will not leave your wallet. Some tokens only allow transfers to their own pool.';

/** Short form for the token row, which has 94px to say it in. */
export const WILL_NOT_MOVE_SHORT = 'will not move';

/**
 * NOT a Multicall3 aggregate3, deliberately, and do not "fix" it into
 * one. `aggregate3` calls each target with `msg.sender` = Multicall3, and
 * the `from` on the outer eth_call does not propagate through it.
 * Multicall3 holds none of these tokens, so every probe would revert on
 * insufficient balance and every token in the wallet would look stuck.
 * The `from` has to be the user, which means one real `eth_call` each.
 *
 * That is why this throttles rather than firing everything at once. The
 * rest of the scan packs 30 contract calls into ONE eth_call through
 * Multicall3, so a 184-token wallet's 552 quotes are only ~19 eth_calls.
 * This probe cannot do that, so the same wallet is 184 of them, which is
 * an order of magnitude more eth_call load than the entire rest of the
 * scan. Measured 5 Sep against the public RPC: a single batch of 50
 * eth_calls returns 200, 100 comes back 429. See docs/LOCAL-TESTING.md,
 * "The public RPC's batch limit".
 */
const PROBES_PER_BATCH = 25;

/**
 * ONE batch in flight, not two. 25 is half the measured eth_call ceiling,
 * so two concurrent batches would sit exactly on it, and the quote phase
 * is running its own two multicalls alongside this. The probe is the
 * expensive half of the scan now, so it is the half that queues.
 */
const PROBE_CONCURRENCY = 1;

/**
 * @param sweeper The Permit2 pull target. Null before the real deploy,
 *   and then there is no recipient to probe against, so the probe is
 *   skipped and nothing is withheld. The read half must keep working
 *   with no contract: that is the whole point of the seam.
 *
 * @returns token address (lowercased) -> can it be transferred to the
 *   Sweeper. A token ABSENT from the map was not probed or could not be
 *   probed, and must be treated as movable rather than as stuck.
 */
export async function probeWillMove(opts: {
  client: PublicClient;
  owner: Address;
  sweeper: Address | null;
  tokens: { address: Address; balance: bigint }[];
  signal?: AbortSignal;
}): Promise<Map<string, boolean>> {
  const { client, owner, sweeper, tokens, signal } = opts;

  const out = new Map<string, boolean>();
  if (!sweeper || tokens.length === 0) return out;
  signal?.throwIfAborted();

  // Narrowed into a local because `probeOne` below is a hoisted function
  // declaration, and TypeScript will not carry the null check across it.
  const recipient = sweeper;

  const groups: (typeof tokens)[] = [];
  for (let i = 0; i < tokens.length; i += PROBES_PER_BATCH) {
    groups.push(tokens.slice(i, i + PROBES_PER_BATCH));
  }

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, groups.length) },
    async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++]!;
        signal?.throwIfAborted();
        // One tick, so the transport coalesces this group into a single
        // JSON-RPC batch. PROBES_PER_BATCH is what keeps that batch
        // under the public RPC's limit.
        await Promise.all(group.map(probeOne));
      }
    },
  );
  await Promise.all(workers);

  return out;

  async function probeOne(t: { address: Address; balance: bigint }) {
    if (t.balance <= 0n) return;
    const key = t.address.toLowerCase();

    try {
      const res = await client.call({
        account: owner,
        to: t.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [recipient, t.balance],
        }),
      });

      // A token that returns false instead of reverting is just as
      // stuck. SafeERC20 inside Permit2 treats the two identically, so
      // the probe has to as well.
      if (res.data && res.data !== '0x') {
        out.set(
          key,
          decodeFunctionResult({
            abi: erc20Abi,
            functionName: 'transfer',
            data: res.data,
          }) === true,
        );
        return;
      }

      // Returned nothing at all, which plenty of real ERC20s do.
      out.set(key, true);
    } catch (err) {
      // Only an actual revert is evidence. A rate limit or a dropped
      // connection says nothing about the token, and recording it as
      // stuck would silently drop somebody's sweepable dust into the
      // no-route pile. Leave those out of the map entirely: absent
      // reads as movable, and the post-approval simulate in useSweep
      // is still sitting behind this as the real backstop.
      if (isRevert(err)) out.set(key, false);
    }
  }
}