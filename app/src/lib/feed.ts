import { decodeFunctionData, erc20Abi, parseEventLogs, type PublicClient } from 'viem';
import { BURN_ADAPTER, SWEEPER } from './addresses';
import { sweeperAbi } from './sweeper';

/**
 * Live feed of real sweeps, read straight off the chain. The janitor
 * stage turns each one into coins on the floor, the counter is the
 * running total of dead tokens sold through the contract, and the
 * graveyard is one headstone per token actually buried. Read-only,
 * public RPC, no key, no wallet needed.
 *
 * `Swept` carries counts, not tokens, so the symbols come from decoding
 * the sweep transaction's own calldata (the `legs` array), dropping the
 * legs the receipt's `LegFailed` events say did not fill, and reading
 * `symbol()` on the rest. One `getTransaction`, one
 * `getTransactionReceipt` and one multicall per sweep, which at the
 * rate anyone sweeps is nothing.
 *
 * ONE eth_getLogs at a time, and only in this file. The public RPC
 * rejects overlapping getLogs calls, and the rejection arrives with a
 * malformed CORS header so the browser reports it as a CORS failure
 * rather than a 429. The backfill is one call, the tail poll is one
 * call every POLL_MS, and the graveyard hydration is zero getLogs: it
 * walks the logs the backfill already fetched, one sweep at a time,
 * awaited, spaced out.
 *
 * Everything here is best-effort decoration. A failed read leaves the
 * counter blank, the plot empty and the floor ambient; it never
 * surfaces as an error.
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

/** One token, buried. Real data only: a stone exists because a sweep
 *  transaction on chain named this token in its `legs`. */
export type Headstone = {
  symbol: string; // '?' when the calldata could not be read
  token: `0x${string}`;
  txHash: `0x${string}`;
  at: number; // unix ms, block timestamp
  /** True when this leg was routed at the BurnAdapter rather than sold.
   *  Read off the leg's own `adapter` field in the sweep calldata, which
   *  `symbolsFor` already decodes, so this costs no extra RPC call. */
  burned: boolean;
};

type Listener = (e: SweepEvent) => void;

/** Roughly a day before the 5 Sep 2026 deploy. setFees landed at 55654464. */
const FROM_BLOCK = 55_000_000n;
const POLL_MS = 15_000;
/** How many of the most recent sweeps get headstones. The odometer
 *  counts every log regardless; the plot says `+N older` past this. */
export const GRAVE_MAX = 40;
/** Pause between hydration reads, so the walk never bunches up on the
 *  public RPC. */
const GRAVE_STEP_MS = 250;

let started = false;
let total = 0;
let totalIsComplete = false;
let last: LastSweep | null = null;
/** Oldest first. */
const graveyard: Headstone[] = [];
/** Legs in sweeps past the hydration cap. They still count in `total`;
 *  they just have no stones, and the plot says "+N older". A sweep whose
 *  reads failed is NOT counted here: it is not older, it is unread, and
 *  the honest thing to show for it is nothing. */
let graveyardOlderLegs = 0;
const listeners = new Set<Listener>();
const totalListeners = new Set<() => void>();
const graveListeners = new Set<() => void>();

export function onSweep(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onTotal(fn: () => void): () => void {
  totalListeners.add(fn);
  return () => totalListeners.delete(fn);
}
export function onGraveyard(fn: () => void): () => void {
  graveListeners.add(fn);
  return () => graveListeners.delete(fn);
}
export function getTotal(): { total: number; complete: boolean } {
  return { total, complete: totalIsComplete };
}
export function getLast(): LastSweep | null {
  return last;
}
/** Oldest first. */
export function getGraveyard(): Headstone[] {
  return graveyard;
}
/** Legs counted in the total that fell past the headstone cap. Zero
 *  until the backfill has finished. */
export function getGraveyardOlder(): number {
  return graveyardOlderLegs;
}

/** Tokens destroyed through the BurnAdapter rather than sold.
 *
 *  Counted from the headstones, so it covers the hydrated window only --
 *  the same GRAVE_MAX cap the plot lives under, and the same honest
 *  "+N older" caveat applies. It is NOT a second chain read: the leg's
 *  adapter comes out of calldata `symbolsFor` already decodes. */
export function getIncinerated(): number {
  return graveyard.reduce((n, h) => n + (h.burned ? 1 : 0), 0);
}

export function startFeed(client: PublicClient) {
  if (started || !SWEEPER) return;
  started = true;
  void run(client);
}

type SweptLog = {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: { user?: `0x${string}`; legsFilled?: bigint; legsAttempted?: bigint; userOut?: bigint };
};

async function run(client: PublicClient) {
  const sweeper = SWEEPER!;
  let cursor: bigint;
  let backfill: SweptLog[] = [];

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
    backfill = logs as SweptLog[];
    total = logs.reduce((n, l) => n + Number(l.args.legsFilled ?? 0n), 0);
    cursor = latest + 1n;
    for (const l of totalListeners) l();

    // The most recent sweep, for the "last:" line under the counter. Two
    // light calls (a block and a tx) plus one multicall; nothing heavy,
    // and nothing here is another eth_getLogs (see the RPC note in
    // claude/dustsweep-decisions.md, 6 Sep: two overlapping getLogs
    // calls get one of them rejected).
    const tail = logs[logs.length - 1];
    // Same one-retry as the hydration walk: the public RPC 429s in
    // bursts, and the "last:" line vanishing for a whole visit because of
    // one bad second is a poor trade.
    for (let attempt = 0; tail && attempt < 2; attempt++) {
      try {
        const block = await client.getBlock({ blockNumber: tail.blockNumber });
        const legs = await symbolsFor(client, tail.transactionHash);
        last = {
          txHash: tail.transactionHash,
          symbols: legs.map((l) => l.symbol),
          legsFilled: Number(tail.args.legsFilled ?? 0n),
          userOutWei: tail.args.userOut ?? 0n,
          at: Number(block.timestamp) * 1000,
        };
        for (const l of totalListeners) l();
        // The tail is already decoded; seed the plot with it rather than
        // reading the same tx twice.
        if (legs.length > 0) bury(legs, tail.transactionHash, last.at);
        break;
      } catch {
        if (attempt === 0) await sleep(GRAVE_STEP_MS * 4);
        // else decoration; leave it blank
      }
    }
  } catch {
    return; // RPC unreachable; stay ambient.
  }

  // Graveyard hydration and the tail poll run side by side. Neither one
  // issues a getLogs except the poll, so nothing here can overlap on
  // that method.
  void hydrateGraveyard(client, backfill);

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
        // Best effort: a failed read here still drops the coins and rolls
        // the counter, it just leaves them unlabelled and unburied.
        const legs = await symbolsFor(client, log.transactionHash).catch(() => []);
        const symbols = legs.map((l) => l.symbol);
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
        // Live stones. Same shape as the backfilled ones; arrival time
        // stands in for the block timestamp, as it does for `last`.
        if (legs.length > 0) bury(legs, ev.txHash, last.at);
      }
    } catch {
      // transient; next tick
    }
  }
}

/**
 * Headstones for the most recent GRAVE_MAX sweeps, newest first, one
 * at a time, awaited, ~250ms apart. Each is one getTransaction, one
 * getTransactionReceipt and one multicall (plus one getBlock for the
 * timestamp). No getLogs, ever. A failure on one sweep gets one retry,
 * then that sweep is skipped and the walk continues.
 *
 * The tail sweep was already buried by `run`, so the walk starts one
 * before it. Anything past the cap is counted into `graveyardOlderLegs`
 * so the plot can say "+N older" without inventing a stone for it.
 */
async function hydrateGraveyard(client: PublicClient, logs: SweptLog[]) {
  const newestFirst = [...logs].reverse();
  const toHydrate = newestFirst.slice(1, GRAVE_MAX); // [0] is the tail, done
  const older = newestFirst.slice(GRAVE_MAX);
  graveyardOlderLegs += older.reduce((n, l) => n + Number(l.args.legsFilled ?? 0n), 0);
  if (older.length > 0) for (const l of graveListeners) l();

  for (const log of toHydrate) {
    await sleep(GRAVE_STEP_MS);
    // One retry after a longer pause: the public RPC 429s in bursts and a
    // stone missing because of one bad second is a poor trade.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const legs = await symbolsFor(client, log.transactionHash);
        if (legs.length > 0) {
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          bury(legs, log.transactionHash, Number(block.timestamp) * 1000);
        }
        break;
      } catch {
        if (attempt === 0) await sleep(GRAVE_STEP_MS * 4);
        // else skip this one, keep walking
      }
    }
  }
}

/** Insert stones for one sweep, keeping the plot oldest-first. */
function bury(
  legs: { token: `0x${string}`; symbol: string; adapter: `0x${string}` }[],
  txHash: `0x${string}`,
  at: number,
) {
  if (graveyard.some((h) => h.txHash === txHash)) return;
  const burnAdapter = BURN_ADAPTER?.toLowerCase();
  const stones: Headstone[] = legs.map((l) => ({
    symbol: l.symbol,
    token: l.token,
    txHash,
    at,
    burned: burnAdapter !== undefined && l.adapter.toLowerCase() === burnAdapter,
  }));
  // Hydration arrives newest-first, live arrives newest-last; find the
  // slot by timestamp so both end up in one oldest-first array.
  let i = graveyard.length;
  while (i > 0 && graveyard[i - 1]!.at > at) i--;
  graveyard.splice(i, 0, ...stones);
  for (const l of graveListeners) l();
}

const sweptEvent = sweeperAbi.find((x) => x.type === 'event' && x.name === 'Swept')! as Extract<
  (typeof sweeperAbi)[number],
  { type: 'event'; name: 'Swept' }
>;

/**
 * The tokens a sweep tx actually SOLD, with their symbols. The calldata
 * `legs` array is what was attempted; `Swept` only carries counts. The
 * receipt's `LegFailed` events name the legs that did not fill, and
 * those are dropped here, because a headstone for a token that went
 * back to its owner's wallet is a lie on a screen whose whole pitch is
 * that the number is true. One getTransaction, one getTransactionReceipt,
 * one multicall. Nothing here is a getLogs.
 */
async function symbolsFor(
  client: PublicClient,
  hash: `0x${string}`,
): Promise<{ token: `0x${string}`; symbol: string; adapter: `0x${string}` }[]> {
  // Throws on an RPC failure so the hydration walk can retry; returns []
  // for a tx that is not a sweep or whose every leg failed.
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  const { functionName, args } = decodeFunctionData({ abi: sweeperAbi, data: tx.input });
  if (functionName !== 'sweep') return [];
  const failed = new Set(
    parseEventLogs({ abi: sweeperAbi, eventName: 'LegFailed', logs: receipt.logs }).map((l) =>
      l.args.token.toLowerCase(),
    ),
  );
  const legs = (args[2] as readonly { token: `0x${string}`; adapter: `0x${string}` }[]).filter(
    (l) => !failed.has(l.token.toLowerCase()),
  );
  if (legs.length === 0) return [];
  const res = await client.multicall({
    allowFailure: true,
    contracts: legs.map((l) => ({ address: l.token, abi: erc20Abi, functionName: 'symbol' as const })),
  });
  return legs.map((l, i) => {
    const r = res[i];
    return {
      token: l.token,
      adapter: l.adapter,
      symbol: r && r.status === 'success' ? String(r.result).slice(0, 12) : '?',
    };
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Hydrate ONE sweep immediately, out of band with the 15s poll.
 *
 * Called by the burn flow the moment its receipt lands. Without it the
 * furnace counter waits up to POLL_MS for the poll to notice a sweep the
 * user is sitting there watching, which on the one screen whose entire
 * job is "the fire lights when the chain says so" reads as broken.
 *
 * This is NOT an optimistic update and it invents nothing: it runs the
 * same `symbolsFor` + `bury` the poll runs, against the real calldata of
 * a mined transaction. `bury` is idempotent on txHash, so the poll
 * arriving at the same sweep a few seconds later is a no-op rather than
 * a double count.
 */
export async function recordLocalSweep(
  client: PublicClient,
  hash: `0x${string}`,
): Promise<void> {
  if (graveyard.some((h) => h.txHash === hash)) return;
  try {
    const legs = await symbolsFor(client, hash);
    if (legs.length === 0) return;
    const tx = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: tx.blockNumber });
    bury(legs, hash, Number(block.timestamp) * 1000);
  } catch {
    // The poll is still coming. A failed fast path costs nothing.
  }
}
