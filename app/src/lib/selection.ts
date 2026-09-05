import type { ScannedToken } from './scan';

/**
 * What gets ticked before the user touches anything.
 *
 * This is the only real lever on tap count in the whole product. There
 * is no batching on 4663, so approvals are one transaction each, and
 * they are per token SELECTED, not per token held. Somebody holding 29
 * pieces of junk who sweeps the 3 that actually pay does 3 approvals
 * instead of 29. That is worth more than either of the closed
 * one-click routes would have been.
 *
 * So: never select-all by default, and never pre-tick anything outside
 * the sweepable pile. Under-gas, no-route and not-dust stay untouched
 * and always require a deliberate click.
 */

/**
 * A token has to clear its own gas this many times over to be worth
 * pre-ticking. At exactly 1x it is break-even and the user has paid a
 * wallet confirmation for nothing; the scan's `underGas` line is already
 * at 1x, so this is the difference between "not a loss" and "worth the
 * tap".
 */
export const DEFAULT_SELECT_GAS_MULTIPLE = 3n;

export function isWorthPreselecting(
  token: ScannedToken,
  gasCostPerLegWei: bigint,
): boolean {
  if (token.pile !== 'sweepable') return false;
  if (gasCostPerLegWei === 0n) return false;
  return token.netOutWei >= gasCostPerLegWei * DEFAULT_SELECT_GAS_MULTIPLE;
}

/**
 * No cap on the count. A wallet with 40 tokens each paying several times
 * their own gas should sweep all 40 -- every one of them is net positive
 * and trimming the list would be quietly leaving the user's money on the
 * chain to make a number on our screen look smaller.
 */
export function defaultSelection(
  tokens: ScannedToken[],
  gasCostPerLegWei: bigint,
): Set<string> {
  return new Set(
    tokens
      .filter((t) => isWorthPreselecting(t, gasCostPerLegWei))
      .map((t) => t.address),
  );
}
