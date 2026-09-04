import { erc20Abi, type PublicClient } from 'viem';
import { FEE_TIERS, TOKENS, UNISWAP_V3 } from './addresses';
import { quoterV2Abi } from './quoter';
import type { HeldToken } from './blockscout';

/**
 * Gas for one token's swap leg inside a batch. ~180k measured on 4663.
 * The gas PRICE is read live every scan -- it is not hardcoded, because
 * the number that decides which pile a token lands in has to be current.
 */
export const GAS_PER_LEG = 180_000n;

/**
 * Haircut applied to the quote before it is compared against gas cost.
 * A quote is a best case: a snapshot of the pool with no other trade in
 * front of it and no slippage bound. Real execution gets less. Comparing
 * the raw quote against gas would push marginal tokens into the
 * sweepable pile, which is exactly the lie this tool exists not to tell.
 */
export const QUOTE_HAIRCUT_BPS = 300n;

/**
 * `Sweeper.feeBpsNative`, read from src/Sweeper.sol. The contract takes
 * this off the gross WETH before paying out in ETH. Kept in sync by
 * hand for now; when the ABI lands, read it from the deployment.
 */
export const SWEEP_FEE_BPS = 300n;

/**
 * A holding worth more than this is not dust, whatever the pools say.
 *
 * Raised from 0.01 to 0.1 ETH on Jake's call. At 0.01 the ceiling held
 * back 29 of the 42 routable tokens in the test wallet, which made the
 * sweepable pile the exception rather than the point. 0.1 ETH is roughly
 * $400 -- still a sane "stop and look at this one" line.
 *
 * This does not weaken the real-asset guard. Robinhood tokens are caught
 * by the name() suffix rule regardless of value, and CBBTC sits around
 * 77 ETH per whole token, far above any ceiling under discussion. The
 * value ceiling is a backstop for what provenance does not catch, not
 * the primary defence.
 */
export const NOT_DUST_CEILING_WEI = 100_000_000_000_000_000n; // 0.1 ETH

/**
 * Robinhood's tokenised equities all name themselves
 * "<Something> • Robinhood Token". Verified on-chain: PLTR, NVDA, AAPL,
 * SPY, SPCX, HIMS, GME, TSLA all match.
 *
 * The separator is U+2022, a real bullet.
 *
 * Match on name, never on symbol and never on a fixed address list. The
 * 184-token test wallet holds a genuine `PLTR` Robinhood Token AND a
 * meme called "Palantir Inu" that also calls itself PLTR, plus an `IBM`
 * whose name is "I BUY MEMES". Symbols on this chain are worthless as
 * identity. New Robinhood tokens also get added over time, so a list
 * goes stale.
 */
export const ROBINHOOD_TOKEN_SUFFIX = '• Robinhood Token';

export function isRobinhoodToken(name: string | null | undefined): boolean {
  return (name ?? '').trimEnd().endsWith(ROBINHOOD_TOKEN_SUFFIX);
}

/** The payout asset and the chain's stablecoin. Never quoted, never shown. */
const NEVER_SWEEP = new Set<string>(
  [TOKENS.WETH, TOKENS.USDG].map((a) => a.toLowerCase()),
);

export type Pile = 'sweepable' | 'underGas' | 'noRoute' | 'notDust';

/** Why a token was held back from the sweepable pile. */
export type NotDustReason = 'robinhoodToken' | 'aboveCeiling' | null;

export type ScannedToken = HeldToken & {
  /** Read on-chain. This is the number we quote and display, not the
   *  indexer's, which can be stale. */
  balance: bigint;
  /** `name()` read on-chain where the token answered, indexer name
   *  otherwise. The not-dust guard keys off this, so it should not
   *  depend on an indexer being up to date. */
  onChainName: string;
  /** Winning fee tier, or null if nothing quoted. */
  bestFee: number | null;
  /** Quoter output in WETH wei at the winning tier. */
  grossOutWei: bigint;
  /** grossOutWei after the haircut. This is what gets compared to gas. */
  netOutWei: bigint;
  /** Per-tier results, so the UI can show why a token has no route. */
  quotes: { fee: number; amountOut: bigint | null }[];
  pile: Pile;
  notDustReason: NotDustReason;
};

export type ScanState = {
  phase: 'idle' | 'listing' | 'quoting' | 'done' | 'error';
  /** Live gas cost of selling one token, in wei. */
  gasCostPerLegWei: bigint;
  gasPriceWei: bigint;
  /** Tokens found by the indexer, before quoting. */
  found: number;
  /** Tokens quoted so far. */
  quoted: number;
  tokens: ScannedToken[];
  error: string | null;
};

export const emptyScan: ScanState = {
  phase: 'idle',
  gasCostPerLegWei: 0n,
  gasPriceWei: 0n,
  found: 0,
  quoted: 0,
  tokens: [],
  error: null,
};

/** How many contract calls go into one Multicall3 aggregate3 request. */
const CALLS_PER_MULTICALL = 30;
/** Concurrent multicalls. The public RPC is rate-limited, so keep it low. */
const CONCURRENCY = 2;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

/**
 * Which pile a token belongs in.
 *
 * The not-dust checks come first and they are deliberately eager. When
 * classification is uncertain the safe direction is always "not dust":
 * being too cautious costs the user one extra click, being too eager
 * costs them an asset once and permanently.
 */
export function classify(args: {
  grossOutWei: bigint;
  netOutWei: bigint;
  bestFee: number | null;
  gasCostPerLegWei: bigint;
  onChainName: string;
}): { pile: Pile; notDustReason: NotDustReason } {
  // A tokenised equity is not dust whatever its pools look like, so this
  // runs before the route check. A Robinhood token with no v3 route is
  // still somebody's stock position, not garbage.
  if (isRobinhoodToken(args.onChainName)) {
    return { pile: 'notDust', notDustReason: 'robinhoodToken' };
  }

  // Ceiling is tested against the RAW quote, not the haircut one. The
  // haircut exists to be pessimistic about proceeds; using it here would
  // make the guard slightly easier to slip past, which is backwards.
  if (args.grossOutWei > NOT_DUST_CEILING_WEI) {
    return { pile: 'notDust', notDustReason: 'aboveCeiling' };
  }

  // No pool, every tier reverted, or the quote rounds to zero.
  // A zero quote must never reach the adapter -- V3Adapter reverts on
  // minOut == 0 by design, because an off-chain quote with no on-chain
  // slippage bound is a sandwich waiting to happen.
  if (args.bestFee === null || args.netOutWei <= 0n) {
    return { pile: 'noRoute', notDustReason: null };
  }

  // Strictly greater. Break-even is not worth a transaction.
  if (args.netOutWei <= args.gasCostPerLegWei) {
    return { pile: 'underGas', notDustReason: null };
  }

  return { pile: 'sweepable', notDustReason: null };
}

/**
 * Full read-half scan: list -> re-read balance and name on chain ->
 * quote every token at all three fee tiers -> sort.
 *
 * `onUpdate` is called after each batch so the UI can fill in as results
 * arrive instead of staring at a spinner. Framework-agnostic on purpose.
 */
export async function scanWallet(opts: {
  client: PublicClient;
  owner: `0x${string}`;
  held: HeldToken[];
  onUpdate: (patch: Partial<ScanState>) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { client, owner, held, onUpdate, signal } = opts;

  const candidates = held.filter((t) => !NEVER_SWEEP.has(t.address.toLowerCase()));
  onUpdate({ phase: 'quoting', found: candidates.length, tokens: [] });

  if (candidates.length === 0) {
    onUpdate({ phase: 'done' });
    return;
  }

  const gasPriceWei = await client.getGasPrice();
  const gasCostPerLegWei = gasPriceWei * GAS_PER_LEG;
  onUpdate({ gasPriceWei, gasCostPerLegWei });

  // Phase 1: authoritative balance and name. The indexer can be stale
  // and we are about to put a price next to these, and to decide from
  // the name whether the token is somebody's stock position.
  const balances = new Map<string, bigint>();
  const names = new Map<string, string>();

  type MetaCall =
    | { token: HeldToken; kind: 'balance' }
    | { token: HeldToken; kind: 'name' };
  const metaCalls: MetaCall[] = candidates.flatMap((token) => [
    { token, kind: 'balance' as const },
    { token, kind: 'name' as const },
  ]);

  await mapWithConcurrency(
    chunk(metaCalls, CALLS_PER_MULTICALL),
    CONCURRENCY,
    async (group) => {
      signal?.throwIfAborted();
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 0,
        contracts: group.map((c) =>
          c.kind === 'balance'
            ? {
                address: c.token.address,
                abi: erc20Abi,
                functionName: 'balanceOf' as const,
                args: [owner] as const,
              }
            : {
                address: c.token.address,
                abi: erc20Abi,
                functionName: 'name' as const,
              },
        ),
      });

      group.forEach((c, i) => {
        const r = results[i];
        if (c.kind === 'balance') {
          // A balanceOf that reverts means a token we cannot reason
          // about. Fall back to the indexer's number rather than
          // dropping it -- it will land in noRoute anyway.
          balances.set(
            c.token.address,
            r?.status === 'success' ? (r.result as bigint) : c.token.indexedBalance,
          );
        } else {
          // Old bytes32-name tokens revert against the string ABI.
          // Fall back to the indexer's name so the guard still gets
          // something to match on.
          names.set(
            c.token.address,
            r?.status === 'success' ? (r.result as string) : c.token.name,
          );
        }
      });
    },
  );

  const live = candidates
    .map((t) => ({
      ...t,
      balance: balances.get(t.address) ?? t.indexedBalance,
      onChainName: names.get(t.address) ?? t.name,
    }))
    .filter((t) => t.balance > 0n);

  // Phase 2: quote every (token, tier) pair. Most dust only has a 10000
  // pool and the other two revert. That is expected, not an error.
  type QuoteCall = { token: (typeof live)[number]; fee: number };
  const calls: QuoteCall[] = live.flatMap((token) =>
    FEE_TIERS.map((fee) => ({ token, fee: fee as number })),
  );

  const quoteResults = new Map<string, bigint | null>();
  let quotedTokens = 0;

  await mapWithConcurrency(
    chunk(calls, CALLS_PER_MULTICALL),
    CONCURRENCY,
    async (group) => {
      signal?.throwIfAborted();
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 0,
        contracts: group.map((c) => ({
          address: UNISWAP_V3.quoterV2,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle' as const,
          args: [
            {
              tokenIn: c.token.address,
              tokenOut: TOKENS.WETH,
              amountIn: c.token.balance,
              fee: c.fee,
              sqrtPriceLimitX96: 0n,
            },
          ] as const,
        })),
      });

      group.forEach((c, i) => {
        const r = results[i];
        quoteResults.set(
          quoteKey(c.token.address, c.fee),
          r?.status === 'success' ? r.result[0] : null,
        );
      });

      quotedTokens = Math.min(
        live.length,
        Math.floor(quoteResults.size / FEE_TIERS.length),
      );
      onUpdate({
        quoted: quotedTokens,
        tokens: assemble(live, quoteResults, gasCostPerLegWei),
      });
    },
  );

  onUpdate({
    phase: 'done',
    quoted: live.length,
    tokens: assemble(live, quoteResults, gasCostPerLegWei),
  });
}

const quoteKey = (addr: string, fee: number) => `${addr}:${fee}`;

function assemble(
  live: (HeldToken & { balance: bigint; onChainName: string })[],
  quoteResults: Map<string, bigint | null>,
  gasCostPerLegWei: bigint,
): ScannedToken[] {
  const out: ScannedToken[] = [];

  for (const token of live) {
    // Every tier still pending -- do not show it yet, a half-quoted
    // token would flash through the wrong pile.
    if (!FEE_TIERS.every((fee) => quoteResults.has(quoteKey(token.address, fee)))) {
      continue;
    }

    const quotes = FEE_TIERS.map((fee) => ({
      fee: fee as number,
      amountOut: quoteResults.get(quoteKey(token.address, fee)) ?? null,
    }));

    let bestFee: number | null = null;
    let grossOutWei = 0n;
    for (const q of quotes) {
      if (q.amountOut !== null && q.amountOut > grossOutWei) {
        grossOutWei = q.amountOut;
        bestFee = q.fee;
      }
    }

    const netOutWei = (grossOutWei * (10_000n - QUOTE_HAIRCUT_BPS)) / 10_000n;
    const { pile, notDustReason } = classify({
      grossOutWei,
      netOutWei,
      bestFee,
      gasCostPerLegWei,
      onChainName: token.onChainName,
    });

    out.push({ ...token, quotes, bestFee, grossOutWei, netOutWei, pile, notDustReason });
  }

  // Most valuable first inside each pile.
  out.sort((a, b) => (b.netOutWei > a.netOutWei ? 1 : b.netOutWei < a.netOutWei ? -1 : 0));
  return out;
}

/** What the user would actually walk away with, given a selection. */
export function totalsFor(selected: ScannedToken[], gasCostPerLegWei: bigint) {
  const gross = selected.reduce((sum, t) => sum + t.netOutWei, 0n);
  const gas = gasCostPerLegWei * BigInt(selected.length);
  const fee = (gross * SWEEP_FEE_BPS) / 10_000n;
  const receive = gross - fee - gas;
  return { count: selected.length, gross, gas, fee, receive };
}
