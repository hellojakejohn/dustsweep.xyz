import { useCallback, useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { fetchHeldTokens } from '../lib/blockscout';
import { emptyScan, scanWallet, type ScanState } from '../lib/scan';

/**
 * Runs the read half for one address. All the actual logic lives in
 * lib/, this is just the React binding.
 */
export function useDustScan(address: `0x${string}` | undefined) {
  const client = usePublicClient();
  const [state, setState] = useState<ScanState>(emptyScan);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!address || !client) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...emptyScan, phase: 'listing' });
    const patch = (p: Partial<ScanState>) => {
      if (controller.signal.aborted) return;
      setState((prev) => ({ ...prev, ...p }));
    };

    try {
      const held = await fetchHeldTokens(address, controller.signal);
      patch({ found: held.length });
      await scanWallet({
        client,
        owner: address,
        held,
        onUpdate: patch,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      patch({
        phase: 'error',
        error: err instanceof Error ? err.message : 'Scan failed',
      });
    }
  }, [address, client]);

  useEffect(() => {
    if (!address) {
      setState(emptyScan);
      return;
    }
    void run();
    return () => abortRef.current?.abort();
  }, [address, run]);

  return { ...state, rescan: run };
}
