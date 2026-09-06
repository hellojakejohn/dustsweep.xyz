import { decodeFunctionData, erc20Abi, type PublicClient } from 'viem';
import { SWEEPER } from './addresses';
import { sweeperAbi } from './sweeper';

/**
 * Live feed of real sweeps, read straight off the chain. The janitor
 * stage turns each one into coins on the floor, and the counter above
 * the floor is the running total of dead tokens sold through the
 * contract. Read-only, public RPC, no key, no wallet needed.
 *
 * `Swept` carries counts, not tokens, so the symbols come from decoding
 * the sweep transaction's own calldata (the `legs` array) and reading
 * `symbol()` on each. One `getTransaction` plus one multicall per sweep,
 * which at the rate anyone sweeps is nothing.
 *
 * Everything here is best-effort decoration. A failed read leaves the
 * counter blank and the floor ambient; it never surfaces as an error.
 */

export type SweepEvent = {
  txHash: `0x${string}`;
  user: `0x${string}`;
  legsFilled: number;
  legsAttempted: number;
  userOutWei: bigint;
  /** Symbols of the tokens in the batch, in leg order. May be empty if
   *  the calldata could not be decoded. */
  symbols: string[];
};

export type LastSweep = {
  txHash: `0x${string}`;
  symbols: string[];
  legsFilled: number;
  userOutWei: bigint;
  /** Unix ms. Block timestamp for the backfilled one, arrival time for live ones. */
  at: number;
};

type Listener = (e: SweepEvent) => void;

/** Roughly a day before the 5 Sep 2026 deploy. setFees landed at 55654464. */
const FROM_BLOCK = 55_000_000n;
const POLL_MS = 15_000;

let started = false;
let total = 0;
let totalIsComplete = false;
let last: LastSweep | null = null;
const listeners = new Set<Listener>();
const totalListeners = new Set<() => void>();

export function onSweep(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onTotal(fn: () => void): () => void {
  totalListeners.add(fn);
  return () => totalListeners.delete(fn);
}
export function getTotal(): { total: number; complete: boolean } {
  return { total, complete: totalIsComplete };
}
export function getLast(): LastSweep | null {
  return last;
}

export function startFeed(client: PublicClient) {
  if (started || !SWEEPER) return;
  started = true;
  void run(client);
}

async function run(client: PublicClient) {
  const sweeper = SWEEPER!;
  let cursor: bigint;

  // Backfill for the counter. Try the whole history in one call; the
  // public RPC may cap the range, so fall back to a recent window and
  // say so via `complete`.
  try {
    const latest = await client.getBlockNumber();
    let logs;
    try {
      logs = await client.getLogs({
        address: sweeper,
        event: sweptEvent,
        fromBlock: FROM_BLOCK,
        toBlock: latest,
      });
      totalIsComplete = true;
    } catch {
      const from = latest > 50_000n ? latest - 50_000n : 0n;
      logs = await client.getLogs({ address: sweeper, event: sweptEvent, fromBlock: from, toBlock: latest });
      totalIsComplete = false;
    }
    total = logs.reduce((n, l) => n + Number(l.args.legsFilled ?? 0n), 0);
    cursor = latest + 1n;
    for (const l of totalListeners) l();

    // The most recent sweep, for the "last:" line under the counter. Two
    // light calls (a block and a tx) plus one multicall; nothing heavy,
    // and nothing here is another eth_getLogs (see the RPC note in
    // claude/dustsweep-decisions.md, 6 Sep: two overlapping getLogs
    // calls get one of them rejected).
    const tail = logs[logs.length - 1];
    if (tail) {
      try {
        const block = await client.getBlock({ blockNumber: tail.blockNumber });
        const symbols = await symbolsFor(client, tail.transactionHash);
        last = {
          txHash: tail.transactionHash,
          symbols,
          legsFilled: Number(tail.args.legsFilled ?? 0n),
          userOutWei: tail.args.userOut ?? 0n,
          at: Number(block.timestamp) * 1000,
        };
        for (const l of totalListeners) l();
      } catch {
        // decoration; leave it blank
      }
    }
  } catch {
    return; // RPC unreachable; stay ambient.
  }

  // Tail. Poll rather than subscribe: the public RPC is HTTP only.
  for (;;) {
    await sleep(POLL_MS);
    try {
      const latest = await client.getBlockNumber();
      if (latest < cursor) continue;
      const logs = await client.getLogs({
        address: sweeper,
        event: sweptEvent,
        fromBlock: cursor,
        toBlock: latest,
      });
      cursor = latest + 1n;
      for (const log of logs) {
        const filled = Number(log.args.legsFilled ?? 0n);
        total += filled;
        for (const l of totalListeners) l();
        const symbols = await symbolsFor(client, log.transactionHash);
        const ev: SweepEvent = {
          txHash: log.transactionHash,
          user: log.args.user!,
          legsFilled: filled,
          legsAttempted: Number(log.args.legsAttempted ?? 0n),
          userOutWei: log.args.userOut ?? 0n,
          symbols,
        };
        last = {
          txHash: ev.txHash,
          symbols,
          legsFilled: filled,
          userOutWei: ev.userOutWei,
          at: Date.now(),
        };
        for (const l of totalListeners) l();
        for (const l of listeners) l(ev);
      }
    } catch {
      // transient; next tick
    }
  }
}

const sweptEvent = sweeperAbi.find((x) => x.type === 'event' && x.name === 'Swept')! as Extract<
  (typeof sweeperAbi)[number],
  { type: 'event'; name: 'Swept' }
>;

async function symbolsFor(client: PublicClient, hash: `0x${string}`): Promise<string[]> {
  try {
    const tx = await client.getTransaction({ hash });
    const { functionName, args } = decodeFunctionData({ abi: sweeperAbi, data: tx.input });
    if (functionName !== 'sweep') return [];
    const legs = args[2] as readonly { token: `0x${string}` }[];
    const res = await client.multicall({
      allowFailure: true,
      contracts: legs.map((l) => ({ address: l.token, abi: erc20Abi, functionName: 'symbol' as const })),
    });
    return res.map((r) => (r.status === 'success' ? String(r.result).slice(0, 12) : '?'));
  } catch {
    return [];
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
