/**
 * EIP-7702 delegated accounts, and why they matter on this path.
 *
 * A delegated EOA has code, and Permit2 branches on exactly that:
 *
 *   if (claimedSigner.code.length == 0) { ecrecover ... }
 *   else { IERC1271(claimedSigner).isValidSignature(...) }
 *
 * So a wallet with a delegation set does not get its signature checked
 * with ecrecover. It gets asked to check its own, and if the delegate
 * does not implement ERC-1271 the sweep reverts with no error data at
 * all, which is the least useful failure available.
 *
 * Both anvil test accounts carry a delegation inherited from real
 * mainnet, which is how this was found: see docs/LOCAL-TESTING.md,
 * "The anvil account is delegated on real mainnet".
 *
 * WHETHER METAMASK'S OWN SMART-ACCOUNT DELEGATOR PASSES ERC-1271 IS
 * UNVERIFIED. It very likely does, since that is the whole point of a
 * smart account. So this warns and never blocks: telling somebody their
 * wallet will not work, and being wrong, costs more than a notice they
 * did not need.
 */

/**
 * The delegation designator prefix from EIP-7702. Account code is
 * exactly `0xef0100 || address`, 23 bytes.
 */
export const DELEGATION_PREFIX = '0xef0100';

export function isDelegatedCode(code: string | undefined | null): boolean {
  return (code ?? '').toLowerCase().startsWith(DELEGATION_PREFIX);
}

/**
 * Shown above the sweep button, before the first approval, so somebody
 * whose signature is going to fail finds out before paying for N
 * approvals rather than after.
 *
 * Deliberately not on the receipt or the share card: by then it either
 * worked, in which case it was noise, or it did not, in which case the
 * error copy below has already said it in more detail.
 */
export const DELEGATED_NOTICE =
  'Your wallet is a smart account (EIP-7702 delegation). The signature step ' +
  'may fail with this kind of wallet. Approvals still stick, so nothing is ' +
  'lost if it does.';

/**
 * Replaces the generic "sweep reverted" copy when the wallet has code AND
 * the revert carried no data. Those two together are the ERC-1271 shape
 * and almost nothing else, so naming it beats a shrug.
 */
export const DELEGATED_REVERT_HINT =
  'The sweep reverted with no error message at all. Your wallet is a smart ' +
  'account (EIP-7702 delegation), and the likely cause is Permit2 asking it ' +
  'to validate the signature and not getting an answer it accepts. Nothing ' +
  'was sold and nothing was sent. Your approvals are still in place.';
