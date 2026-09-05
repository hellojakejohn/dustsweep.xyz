import {
  decodeErrorResult,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';

/**
 * The Sweeper's ABI, hand-written from src/Sweeper.sol rather than
 * generated, so it stays readable and reviewable next to the contract.
 *
 * The custom errors are in here on purpose. Without them viem hands back
 * a raw four-byte selector on a revert and the user gets a hex string
 * instead of a reason, which on this path is the difference between "the
 * pool moved, try again" and "something went wrong".
 */
export const sweeperAbi = [
  {
    type: 'function',
    name: 'sweep',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
      {
        name: 'legs',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'adapter', type: 'address' },
          { name: 'minOut', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'wantPayout', type: 'bool' },
      { name: 'minPayout', type: 'uint256' },
    ],
    outputs: [{ name: 'userOut', type: 'uint256' }],
  },

  // Reads the write half depends on. `maxLegValueWei` is read, never
  // hardcoded: one leg over the ceiling reverts the whole batch and the
  // user pays gas for nothing, so the UI has to know the live number.
  {
    type: 'function',
    name: 'maxLegValueWei',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feeBpsNative',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'adapterAllowed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'WETH',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },

  {
    type: 'event',
    name: 'Swept',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'legsAttempted', type: 'uint256', indexed: false },
      { name: 'legsFilled', type: 'uint256', indexed: false },
      { name: 'grossWeth', type: 'uint256', indexed: false },
      { name: 'feeWeth', type: 'uint256', indexed: false },
      { name: 'userOut', type: 'uint256', indexed: false },
      { name: 'paidInPayoutToken', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LegFailed',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'reason', type: 'bytes', indexed: false },
    ],
  },
  /**
   * Emitted when a failed leg's token could not even be handed back: a
   * honeypot that reverts on `transfer` out. The contract keeps it, on
   * purpose, because reverting inside the catch handler would take down
   * every other leg in the batch.
   *
   * This is the one case where "your tokens are still yours" is FALSE,
   * so the receipt has to read this event and say so. A LegFailed with
   * no matching LegStranded came back to the wallet; one with a match
   * did not and is not coming back.
   */
  {
    type: 'event',
    name: 'LegStranded',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },

  { type: 'error', name: 'NoLegs', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'AdapterNotAllowed', inputs: [{ type: 'address' }] },
  {
    type: 'error',
    name: 'LegValueTooHigh',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
  },
  { type: 'error', name: 'NothingFilled', inputs: [] },
  { type: 'error', name: 'FeeTooHigh', inputs: [] },
  { type: 'error', name: 'PayoutUnavailable', inputs: [] },
  { type: 'error', name: 'EthTransferFailed', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
] as const satisfies Abi;

/**
 * Errors the adapter throws. Never called directly, but a leg that fails
 * inside the Sweeper's try/catch comes back as raw bytes in `LegFailed`,
 * and these are what those bytes usually are.
 */
export const adapterErrorsAbi = [
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'NoSlippageBound', inputs: [] },
  { type: 'error', name: 'CannotSellWeth', inputs: [] },
  { type: 'error', name: 'BadFeeData', inputs: [] },
  // Uniswap's own, and the one a stale quote actually produces.
  { type: 'error', name: 'Error', inputs: [{ type: 'string' }] },
] as const satisfies Abi;

export type SweeperConfig = {
  maxLegValueWei: bigint;
  feeBpsNative: bigint;
  adapterAllowed: boolean;
  weth: Address;
};

/**
 * Everything the flow needs to know about the deployment before it puts
 * a number in front of the user. Reverts loudly rather than falling back
 * to a guess: a wrong ceiling here is a reverted batch later.
 */
export async function readSweeperConfig(
  client: PublicClient,
  sweeper: Address,
  adapter: Address,
): Promise<SweeperConfig> {
  const [maxLeg, feeBps, allowed, weth] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: sweeper, abi: sweeperAbi, functionName: 'maxLegValueWei' },
      { address: sweeper, abi: sweeperAbi, functionName: 'feeBpsNative' },
      { address: sweeper, abi: sweeperAbi, functionName: 'adapterAllowed', args: [adapter] },
      { address: sweeper, abi: sweeperAbi, functionName: 'WETH' },
    ],
  });

  return {
    maxLegValueWei: maxLeg,
    feeBpsNative: feeBps,
    adapterAllowed: allowed,
    weth,
  };
}

export type FailedLeg = {
  token: Address;
  reason: string;
  /** False when the contract could not hand the token back. */
  returned: boolean;
  /** Raw amount left in the contract. Null when it was returned. */
  strandedAmount: bigint | null;
};

export type SweepReceipt = {
  hash: Hex;
  /** From the Swept event, not from what we asked for. */
  legsAttempted: number;
  legsFilled: number;
  grossWei: bigint;
  feeWei: bigint;
  /** ETH that actually landed in the wallet. */
  userOutWei: bigint;
  failed: FailedLeg[];
  /** Convenience: the subset of `failed` the contract could not return. */
  stranded: FailedLeg[];
  gasUsedWei: bigint;
};

/**
 * What actually happened, read back off the chain.
 *
 * Deliberately built from the events rather than from the arguments we
 * sent. A sweep where 9 of 12 legs filled is a success and the other 3
 * are back in the wallet, and the only way to say that truthfully is to
 * read what the contract emitted.
 */
export function parseSweepReceipt(
  receipt: TransactionReceipt,
  sweeper: Address,
): SweepReceipt | null {
  const mine = receipt.logs.filter(
    (l) => l.address.toLowerCase() === sweeper.toLowerCase(),
  );

  const swept = parseEventLogs({ abi: sweeperAbi, eventName: 'Swept', logs: mine });
  const failedLogs = parseEventLogs({
    abi: sweeperAbi,
    eventName: 'LegFailed',
    logs: mine,
  });
  const strandedLogs = parseEventLogs({
    abi: sweeperAbi,
    eventName: 'LegStranded',
    logs: mine,
  });

  const head = swept[0];
  if (!head) return null;

  // `_returnOrStrand` emits LegStranded immediately after the LegFailed
  // it belongs to, so pair on the first matching token AFTER each
  // failure rather than on token alone. The front end dedupes, so one
  // token twice in a batch should be impossible, but pairing by log
  // order costs nothing and does not rely on that staying true.
  const unclaimed = [...strandedLogs];
  const failed: FailedLeg[] = failedLogs.map((l) => {
    const i = unclaimed.findIndex(
      (st) =>
        st.args.token.toLowerCase() === l.args.token.toLowerCase() &&
        (st.logIndex ?? 0) > (l.logIndex ?? 0),
    );
    const match = i === -1 ? null : unclaimed.splice(i, 1)[0];
    return {
      token: l.args.token,
      reason: decodeLegReason(l.args.reason),
      returned: match === null,
      strandedAmount: match ? match.args.amount : null,
    };
  });

  return {
    hash: receipt.transactionHash,
    legsAttempted: Number(head.args.legsAttempted),
    legsFilled: Number(head.args.legsFilled),
    grossWei: head.args.grossWeth,
    feeWei: head.args.feeWeth,
    userOutWei: head.args.userOut,
    failed,
    stranded: failed.filter((f) => !f.returned),
    gasUsedWei: receipt.gasUsed * receipt.effectiveGasPrice,
  };
}

/**
 * `LegFailed.reason` is whatever the adapter or the router reverted with,
 * forwarded raw. Usually a four-byte custom-error selector, sometimes an
 * `Error(string)`, occasionally empty when a token reverts bare.
 */
export function decodeLegReason(reason: Hex): string {
  if (!reason || reason === '0x') return 'reverted with no reason';

  for (const abi of [adapterErrorsAbi, sweeperAbi] as const) {
    try {
      const decoded = decodeErrorResult({ abi, data: reason });
      if (decoded.errorName === 'Error') {
        return String(decoded.args?.[0] ?? 'reverted');
      }
      return decoded.errorName;
    } catch {
      /* not this ABI, try the next */
    }
  }

  // Uniswap's "Too little received" is the one to expect from a stale
  // quote, and it arrives as a plain string revert that the loop above
  // already catches. Anything left is genuinely unknown, so show the
  // selector rather than inventing a friendlier lie.
  return `unrecognised revert ${reason.slice(0, 10)}`;
}
