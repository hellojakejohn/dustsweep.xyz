import { formatUnits } from 'viem';

/** ETH with enough precision to be honest about dust. */
export function formatEth(wei: bigint): string {
  if (wei === 0n) return '0';
  const n = Number(formatUnits(wei, 18));
  if (n < 0.0000001) return '<0.0000001';
  if (n < 0.001) return n.toFixed(7);
  if (n < 1) return n.toFixed(5);
  return n.toFixed(4);
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return '<0.0001';
  if (n < 1) return n.toFixed(4);
  if (n < 1_000) return n.toFixed(2);
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatGwei(wei: bigint): string {
  return Number(formatUnits(wei, 9)).toFixed(3);
}

/** Same as formatEth but without trailing zeros. For prose, not tables. */
export function formatEthTrim(wei: bigint): string {
  const s = formatEth(wei);
  return s.includes('.') && !s.startsWith('<') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
