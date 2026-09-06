import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { SWEEPER } from '../lib/addresses';
import { sweeperAbi } from '../lib/sweeper';

/**
 * `Sweeper.feeBpsNative`, read once on load for the preview totals.
 *
 * This is display only. The write half reads the same value again in
 * `readSweeperConfig` right before it signs, and that read is the one
 * that governs. Returns `null` until the call comes back, or if there is
 * no Sweeper address, so the card can say "loading" instead of quoting a
 * number the contract might not agree with.
 */
export function useSweeperFee(): bigint | null {
  const client = usePublicClient();
  const [fee, setFee] = useState<bigint | null>(null);

  useEffect(() => {
    if (!client || SWEEPER === null) return;
    let cancelled = false;
    client
      .readContract({ address: SWEEPER, abi: sweeperAbi, functionName: 'feeBpsNative' })
      .then((v) => {
        if (!cancelled) setFee(v);
      })
      .catch(() => {
        // Leave it null. The preview shows "(loading)" and the sweep
        // itself re-reads before signing, so nothing downstream trusts this.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return fee;
}
