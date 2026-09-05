/**
 * Permit2 batch signature for the sweep.
 *
 * THE THING THAT WILL BITE YOU: Permit2 does not remove approvals, it
 * centralises them. Before Permit2 can move a token on someone's behalf,
 * that someone must have run a normal ERC20 `approve(PERMIT2, ...)` for
 * that token, once, ever. Only after that does the batch signature work.
 *
 * So the real flow for a first-time user holding N un-approved tokens is:
 *
 *     N approve transactions  ->  1 signature  ->  1 sweep transaction
 *
 * not "one transaction". Show that honestly. See `approvalPlan()`.
 */

import type { Address, WalletClient, PublicClient, Hex } from 'viem';
import { maxUint256 } from 'viem';

export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const CHAIN_ID = 4663;

/**
 * Permit2's EIP-712 domain has NO `version` field. Adding one produces a
 * different domain separator, a valid-looking signature, and an
 * InvalidSigner revert that tells you nothing. This is the single most
 * common way to lose an afternoon here.
 */
export const permit2Domain = {
  name: 'Permit2',
  chainId: CHAIN_ID,
  verifyingContract: PERMIT2,
} as const;

export const permitBatchTypes = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PermitBatchTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type TokenPermission = { token: Address; amount: bigint };

const ERC20_ALLOWANCE_ABI = [{
  name: 'allowance', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
  outputs: [{ type: 'uint256' }],
}] as const;

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const;

const PERMIT2_NONCE_ABI = [{
  name: 'nonceBitmap', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'word', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}] as const;

/**
 * Exact-amount approvals, not `type(uint256).max`.
 *
 * Uniswap's own front end approves Permit2 for the maximum and never
 * asks again, and that is a defensible choice. It is not this one. The
 * disclosure line under the card says "exact-amount approvals" in every
 * state, and a wallet prompt reading "Unlimited" three seconds after a
 * stranger read that line is the kind of small lie this whole project
 * is a bet against. Dust gets swept once, so the cost of re-approving is
 * theoretical and the cost of that prompt is the funnel.
 *
 * Flip this to false to go back to infinite approvals. Everything else,
 * including the plan builder and the amount-aware allowance check below,
 * works unchanged either way.
 */
export const APPROVE_EXACT = true;

/**
 * One wallet confirmation. A token whose allowance is non-zero but too
 * small needs two: some ERC20s (the USDT shape) revert on a non-zero to
 * non-zero `approve`, so the allowance is zeroed first. Both steps are
 * shown to the user rather than collapsed, because the count in front of
 * them has to be the number of times the wallet will actually pop up.
 */
export type ApprovalStep = {
  kind: 'reset' | 'approve';
  token: Address;
  symbol: string;
  /** What to approve. Zero for a reset. */
  amount: bigint;
};

export async function readAllowances(
  publicClient: PublicClient,
  owner: Address,
  tokens: Address[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (tokens.length === 0) return out;

  const results = await publicClient.multicall({
    contracts: tokens.map((token) => ({
      address: token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance' as const,
      args: [owner, PERMIT2] as const,
    })),
    allowFailure: true,
  });

  results.forEach((r, i) => {
    // A token whose `allowance` reverts is not a token we can sweep. Call
    // it zero so it shows up as needing approval and fails at the first
    // step, in front of the user, rather than silently mid-sweep.
    out.set(
      tokens[i].toLowerCase(),
      r.status === 'success' ? (r.result as bigint) : 0n,
    );
  });
  return out;
}

/**
 * The wallet confirmations this selection costs, in order.
 *
 * Call this BEFORE showing a cost estimate and put the count in front of
 * the user. Each entry is a transaction they pay for.
 *
 * Note this compares against the AMOUNT, not against zero. With exact
 * approvals a leftover allowance smaller than the balance is worse than
 * no allowance at all: a zero-check would call it approved and the sweep
 * would revert inside Permit2's `transferFrom` with nothing useful.
 */
export function approvalPlan(
  wants: { token: Address; symbol: string; amount: bigint }[],
  allowances: Map<string, bigint>,
): ApprovalStep[] {
  const steps: ApprovalStep[] = [];

  for (const want of wants) {
    if (want.amount === 0n) continue;
    const current = allowances.get(want.token.toLowerCase()) ?? 0n;
    if (current >= want.amount) continue;

    if (current > 0n) {
      steps.push({ kind: 'reset', token: want.token, symbol: want.symbol, amount: 0n });
    }
    steps.push({
      kind: 'approve',
      token: want.token,
      symbol: want.symbol,
      amount: APPROVE_EXACT ? want.amount : maxUint256,
    });
  }

  return steps;
}

/** The tokens that still need at least one confirmation. */
export async function approvalsNeeded(
  publicClient: PublicClient,
  owner: Address,
  wants: { token: Address; symbol: string; amount: bigint }[],
): Promise<ApprovalStep[]> {
  const allowances = await readAllowances(
    publicClient,
    owner,
    wants.map((w) => w.token),
  );
  return approvalPlan(wants, allowances);
}

export function approveTx(token: Address, amount: bigint) {
  return {
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve' as const,
    args: [PERMIT2, amount] as const,
  };
}

/**
 * Permit2 nonces are unordered: a 256-bit value split into a word index
 * (nonce >> 8) and a bit (nonce & 0xff). Any unset bit is usable, so we
 * pick a random word and take the first free bit in it.
 */
export async function findUnusedNonce(
  publicClient: PublicClient,
  owner: Address,
): Promise<bigint> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const word = BigInt(Math.floor(Math.random() * 2 ** 32));
    const bitmap = await publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_NONCE_ABI,
      functionName: 'nonceBitmap',
      args: [owner, word],
    });
    if (bitmap === maxUint256) continue; // fully used, vanishingly unlikely
    for (let bit = 0n; bit < 256n; bit++) {
      if (((bitmap >> bit) & 1n) === 0n) return (word << 8n) | bit;
    }
  }
  throw new Error('could not find an unused Permit2 nonce');
}

export type SignedPermit = {
  permitted: TokenPermission[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
};

/**
 * @param sweeper  The deployed Sweeper. This is the `spender` in the signed
 *                 payload; sign for the wrong address and Permit2 rejects it.
 * @param ttl      Seconds. Blocks here are ~100ms, so use timestamps, never
 *                 block numbers, for anything time-based.
 */
export async function signSweepPermit(
  walletClient: WalletClient,
  publicClient: PublicClient,
  owner: Address,
  sweeper: Address,
  permitted: TokenPermission[],
  ttl = 1800n,
): Promise<SignedPermit> {
  if (permitted.length === 0) throw new Error('nothing to sign');

  const nonce = await findUnusedNonce(publicClient, owner);
  const block = await publicClient.getBlock();

  // Floored at wall clock. On 4663 the two agree to within a couple of
  // blocks, but an idle anvil fork does not mine, so `block.timestamp`
  // there is the time of the last transaction -- half an hour of reading
  // the screen and every signature is born expired. Taking the later of
  // the two is correct on both.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const base = block.timestamp > now ? block.timestamp : now;
  const deadline = base + ttl;

  const signature = await walletClient.signTypedData({
    account: owner,
    domain: permit2Domain,
    types: permitBatchTypes,
    primaryType: 'PermitBatchTransferFrom',
    message: { permitted, spender: sweeper, nonce, deadline },
  });

  return { permitted, nonce, deadline, signature };
}

/**
 * The legs array must line up with `permitted` index for index. Sweeper
 * reverts with LengthMismatch otherwise, and that check is the thing
 * stopping a leg being pointed at a token the user never signed for.
 */
export type Leg = { token: Address; adapter: Address; minOut: bigint; data: Hex };

export function buildSweepArgs(signed: SignedPermit, legs: Leg[]) {
  if (legs.length !== signed.permitted.length) {
    throw new Error('legs and permitted must be the same length');
  }
  legs.forEach((leg, i) => {
    if (leg.token.toLowerCase() !== signed.permitted[i].token.toLowerCase()) {
      throw new Error(`leg ${i} token does not match the signed permit`);
    }
  });

  return [
    { permitted: signed.permitted, nonce: signed.nonce, deadline: signed.deadline },
    signed.signature,
    legs,
    false,  // wantPayout: MUST stay false until setPayout has been called
    0n,     // minPayout: unused while wantPayout is false
  ] as const;
}
