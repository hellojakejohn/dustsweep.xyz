import { encodeAbiParameters, erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { FEE_TIERS, TOKENS, UNISWAP_V3 } from './addresses';
import { PERMIT2 } from './permit2';
import { quoterV2Abi } from './quoter';
import { QUOTE_HAIRCUT_BPS, type ScannedToken } from './scan';

/**
 * The last read before anything is signed.
 *
 * A quote is a snapshot. Someone scans, makes a coffee, comes back and
 * presses the button with `minOut` values the pool can no longer honour,
 * and every leg reverts inside the Sweeper's try/catch: the batch costs
 * full gas and fills nothing. So the selected tokens get re-read and
 * re-quoted immediately before the permit is built, and the numbers that
 * go into the signature are these, never the scan's.
 *
 * Nothing here touches scan.ts. The pile logic is the read half's and it
 * is done; this is a narrower job on a handful of tokens.
 */

/**
 * Slippage bound on each leg, and deliberately the same 3% the scan
 * already subtracts for display. That makes the number the user was
 * shown the number the contract enforces, rather than an optimistic
 * headline with a looser floor hidden behind it.
 */
export const SLIPPAGE_BPS = QUOTE_HAIRCUT_BPS;

/**
 * How far a quote may move between the scan and the signature before the
 * user has to look at it again. Only downward moves stop the flow --
 * finding out a token is worth more than you were told is not a reason
 * to make someone click.
 */
export const DRIFT_ALERT_BPS = 300n; // 3%

export type DropReason =
  | 'notApproved'
  | 'zeroBalance'
  | 'noQuote'
  | 'underGas'
  | 'aboveLegCeiling';

export const DROP_REASON_COPY: Record<DropReason, string> = {
  notApproved: 'not approved, so it cannot be moved',
  zeroBalance: 'balance is now zero',
  noQuote: 'no pool will quote it any more',
  underGas: 'now worth less than the gas to sell it',
  aboveLegCeiling: 'quotes above the contract value ceiling',
};

export type SweepLeg = {
  token: ScannedToken;
  /** What the permit will move. Never more than the live allowance. */
  amount: bigint;
  fee: number;
  /** Fresh quote for exactly `amount`. */
  grossOutWei: bigint;
  /** `grossOutWei` less slippage. This is what the adapter enforces. */
  minOut: bigint;
  /** abi.encode(uint24 fee). */
  data: Hex;
};

export type DroppedLeg = { token: ScannedToken; reason: DropReason };

export type DriftRow = {
  token: ScannedToken;
  /** What the scan said, after its haircut. */
  beforeWei: bigint;
  /** What it says now, after the same haircut. */
  afterWei: bigint;
};

export type RequoteResult = {
  legs: SweepLeg[];
  dropped: DroppedLeg[];
  /** Downward moves past DRIFT_ALERT_BPS. Non-empty means stop and ask. */
  drifted: DriftRow[];
};

const ALLOWANCE_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export function encodeFee(fee: number): Hex {
  return encodeAbiParameters([{ type: 'uint24' }], [fee]);
}

export function applySlippage(gross: bigint): bigint {
  return (gross * (10_000n - SLIPPAGE_BPS)) / 10_000n;
}

/**
 * @param maxLegValueWei Read live from `Sweeper.maxLegValueWei`, never
 *   hardcoded. The contract reverts the WHOLE batch on one leg over the
 *   ceiling, so a token that has drifted above it is dropped here rather
 *   than taking the other legs down with it.
 */
export async function requoteForSweep(opts: {
  client: PublicClient;
  owner: Address;
  tokens: ScannedToken[];
  gasCostPerLegWei: bigint;
  maxLegValueWei: bigint;
}): Promise<RequoteResult> {
  const { client, owner, gasCostPerLegWei, maxLegValueWei } = opts;

  // The same token twice processes as zero on the second pass: the
  // first leg drains the balance and the second finds nothing. Harmless
  // but it costs the user a permit slot and a line on the receipt.
  const seen = new Set<string>();
  const tokens = opts.tokens.filter((t) => {
    const key = t.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (tokens.length === 0) return { legs: [], dropped: [], drifted: [] };

  // Balance and allowance together: the permit amount is the smaller of
  // the two. Asking for more than the allowance covers is how an exact
  // approval turns into a whole batch reverting inside Permit2, and
  // capping costs at most the difference, which is normally nothing.
  const state = await client.multicall({
    allowFailure: true,
    batchSize: 0,
    contracts: tokens.flatMap((t) => [
      {
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [owner] as const,
      },
      {
        address: t.address,
        abi: ALLOWANCE_ABI,
        functionName: 'allowance' as const,
        args: [owner, PERMIT2] as const,
      },
    ]),
  });

  const amounts = new Map<string, bigint>();
  const dropped: DroppedLeg[] = [];

  tokens.forEach((t, i) => {
    const bal = state[i * 2];
    const allow = state[i * 2 + 1];
    const balance = bal?.status === 'success' ? (bal.result as bigint) : 0n;
    const allowance = allow?.status === 'success' ? (allow.result as bigint) : 0n;

    if (balance === 0n) {
      dropped.push({ token: t, reason: 'zeroBalance' });
      return;
    }
    if (allowance === 0n) {
      dropped.push({ token: t, reason: 'notApproved' });
      return;
    }
    amounts.set(t.address.toLowerCase(), balance < allowance ? balance : allowance);
  });

  const live = tokens.filter((t) => amounts.has(t.address.toLowerCase()));
  if (live.length === 0) return { legs: [], dropped, drifted: [] };

  // Re-quote all three tiers, not just the one the scan picked. The
  // winning tier can change: these pools are thin enough that a single
  // trade elsewhere moves which one pays best.
  const calls = live.flatMap((token) =>
    FEE_TIERS.map((fee) => ({ token, fee: fee as number })),
  );

  const quotes = await client.multicall({
    allowFailure: true,
    batchSize: 0,
    contracts: calls.map((c) => ({
      address: UNISWAP_V3.quoterV2,
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle' as const,
      args: [
        {
          tokenIn: c.token.address,
          tokenOut: TOKENS.WETH,
          amountIn: amounts.get(c.token.address.toLowerCase())!,
          fee: c.fee,
          sqrtPriceLimitX96: 0n,
        },
      ] as const,
    })),
  });

  const best = new Map<string, { fee: number; out: bigint }>();
  calls.forEach((c, i) => {
    const r = quotes[i];
    if (r?.status !== 'success') return;
    const out = (r.result as readonly bigint[])[0];
    const key = c.token.address.toLowerCase();
    const prev = best.get(key);
    if (out > 0n && (!prev || out > prev.out)) best.set(key, { fee: c.fee, out });
  });

  const legs: SweepLeg[] = [];
  const drifted: DriftRow[] = [];

  for (const token of live) {
    const key = token.address.toLowerCase();
    const amount = amounts.get(key)!;
    const win = best.get(key);

    if (!win) {
      dropped.push({ token, reason: 'noQuote' });
      continue;
    }
    // Compared against the RAW quote, the same way the contract compares
    // against the raw fill.
    if (win.out > maxLegValueWei) {
      dropped.push({ token, reason: 'aboveLegCeiling' });
      continue;
    }

    const minOut = applySlippage(win.out);
    // V3Adapter reverts on minOut == 0 by design. A quote that rounds to
    // nothing after slippage is a no-route token, not a cheap one.
    if (minOut === 0n) {
      dropped.push({ token, reason: 'noQuote' });
      continue;
    }
    if (minOut <= gasCostPerLegWei) {
      dropped.push({ token, reason: 'underGas' });
      continue;
    }

    legs.push({
      token,
      amount,
      fee: win.fee,
      grossOutWei: win.out,
      minOut,
      data: encodeFee(win.fee),
    });

    const floor = (token.netOutWei * (10_000n - DRIFT_ALERT_BPS)) / 10_000n;
    if (minOut < floor) {
      drifted.push({ token, beforeWei: token.netOutWei, afterWei: minOut });
    }
  }

  return { legs, dropped, drifted };
}

/** What the user walks away with, from the fresh numbers. */
export function legTotals(
  legs: SweepLeg[],
  gasCostPerLegWei: bigint,
  feeBps: bigint,
) {
  const gross = legs.reduce((sum, l) => sum + l.minOut, 0n);
  const gas = gasCostPerLegWei * BigInt(legs.length);
  const fee = (gross * feeBps) / 10_000n;
  return { count: legs.length, gross, gas, fee, receive: gross - fee - gas };
}
