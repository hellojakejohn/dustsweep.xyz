import { useSyncExternalStore } from 'react';

/**
 * One bit of shared UI state: is the app doing work right now (scanning,
 * quoting, sweeping)? The janitor stage reads it to change how fast the
 * coins fall. Nothing in the sell path reads or writes this; it is
 * decoration only, which is why it lives in its own file rather than in
 * a hook that touches the sweep.
 */
let busy = false;
const listeners = new Set<() => void>();

export function setBusy(next: boolean) {
  if (busy === next) return;
  busy = next;
  for (const l of listeners) l();
}

export function useBusy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => busy,
    () => false,
  );
}
