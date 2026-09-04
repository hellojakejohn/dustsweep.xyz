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
 * not "one transaction". Show that honestly. See `approvalsNeeded()`.
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
 * Which of these tokens still need a one-off ERC20 approve to Permit2.
 * Call this BEFORE showing a cost estimate, and put the count in front of
 * the user. Each one is a transaction they pay for.
 */
export async function approvalsNeeded(
  publicClient: PublicClient,
  owner: Address,
  tokens: Address[],
): Promise<Address[]> {
  const results = await publicClient.multicall({
    contracts: tokens.map((token) => ({
      address: token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance' as const,
      args: [owner, PERMIT2] as const,
    })),
    allowFailure: true,
  });

  const needed: Address[] = [];
  results.forEach((r, i) => {
    // A token whose allowance call reverts is not sweepable anyway; the
    // scan should already have binned it. Treat it as needing approval so
    // the failure surfaces early rather than mid-sweep.
    if (r.status !== 'success' || (r.result as bigint) === 0n) needed.push(tokens[i]);
  });
  return needed;
}

export function approveTx(token: Address) {
  return {
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve' as const,
    args: [PERMIT2, maxUint256] as const,
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
  const deadline = block.timestamp + ttl;

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
