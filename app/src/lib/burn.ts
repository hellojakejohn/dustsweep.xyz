import { erc20Abi, type PublicClient } from 'viem';
import { SWEEP_TOKEN } from './addresses';

/**
 * SWEEP burned, read the one way that cannot be dressed up: the balance
 * of the burn address.
 *
 * There is no burner contract in this read, no event, no index and no
 * number that only this site can produce. `balanceOf(0x…dEaD)` is true
 * whoever asks, and anyone can check it against Blockscout in ten
 * seconds. On a project whose only real brand asset is verifiability
 * that matters more than the number being big.
 *
 * ONE light eth_call per minute. Deliberately NOT an eth_getLogs: the
 * public RPC rejects a getLogs that overlaps another in flight and
 * reports it to the browser as a CORS failure, so lib/feed.ts owns the
 * only two getLogs calls the app makes (see claude/dustsweep-decisions.md,
 * 6 Sep). Light methods are unaffected, which is why this file is
 * allowed to exist alongside the feed.
 *
 * Best-effort decoration. A failed read renders nothing at all; it never
 * surfaces as an error and it never shows a stale or invented figure.
 */

/** The burn address. Nothing sent here comes back. */
export const DEAD = '0x000000000000000000000000000000000000dEaD' as const;

/** Fixed at launch by PonsV2LauncherToken's constructor. There is no
 *  mint path, so this is the only number circulating supply is measured
 *  against. */
export const SWEEP_SUPPLY = 1_000_000_000n * 10n ** 18n;

const POLL_MS = 60_000;

let started = false;
/** null until a read has actually succeeded. Zero is a real answer and
 *  is drawn as a cold furnace; null is "we do not know" and is drawn as
 *  nothing. Do not collapse the two. */
let burned: bigint | null = null;
const listeners = new Set<() => void>();

export function onBurn(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getBurned(): bigint | null {
  return burned;
}

/**
 * DEV SERVER ONLY. `?burn=25000000` seeds a figure so the lit furnace can
 * be looked at before BuybackBurner exists and there is anything real to
 * show.
 *
 * Gated on `import.meta.env.DEV`, which Vite replaces with a literal
 * `false` in a production build, so the whole branch is dead code the
 * minifier removes. That gate is not optional and it is not a style
 * choice: a site whose entire pitch is that the number on it is true
 * must not ship a URL that fakes the number. Anyone could screenshot it.
 */
function devOverride(): bigint | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('burn');
  if (raw === null) return null;
  const whole = raw.replace(/[_,\s]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  return BigInt(whole) * 10n ** 18n;
}

export function startBurnFeed(client: PublicClient) {
  if (started) return;
  started = true;
  const fake = devOverride();
  if (fake !== null) {
    burned = fake;
    for (const l of listeners) l();
    return; // do not let the real read overwrite what you asked to see
  }
  void run(client);
}

async function run(client: PublicClient) {
  for (;;) {
    try {
      const next = (await client.readContract({
        address: SWEEP_TOKEN,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [DEAD],
      })) as bigint;
      if (next !== burned) {
        burned = next;
        for (const l of listeners) l();
      }
    } catch {
      // Transient. Keep whatever was last read; if nothing has ever been
      // read the furnace stays off the page.
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* --- ignition ------------------------------------------------------- */

/**
 * The one-shot signal that a burn belonging to THIS user just landed.
 *
 * Separate from `onBurn` on purpose. `onBurn` is a value changing and
 * fires for anybody's burn on the next poll; this is an event, it fires
 * once, and it exists so the furnace can flare at the moment the person
 * who paid for it is looking at the screen. Nothing about the numbers on
 * the furnace depends on it -- if this never fires, the furnace still
 * reads the chain and still lights. It only changes the timing of an
 * animation, which is why it is allowed to be optimistic where the
 * counters are not.
 */
const igniteListeners = new Set<() => void>();

export function onIgnite(fn: () => void): () => void {
  igniteListeners.add(fn);
  return () => igniteListeners.delete(fn);
}

export function ignite(): void {
  for (const l of igniteListeners) l();
}

/* --- the burn overlay ------------------------------------------------
 *
 * The Cremation overlay tells the furnace it is open, and the furnace
 * stays lifted above the scrim for as long as it is.
 *
 * WHY THIS EXISTS. The flare used to drop the furnace's z-index back the
 * instant it finished, which shoved it under a scrim that was still on
 * screen -- so mid-receipt the fire visibly fell into shadow for no
 * reason the viewer could see. Tying the lift to the overlay's lifetime
 * instead means the furnace and the scrim leave together, and there is
 * no in-between frame to be jarring.
 */
let overlayOpen = false;
const overlayListeners = new Set<() => void>();

export function onBurnOverlay(fn: () => void): () => void {
  overlayListeners.add(fn);
  return () => overlayListeners.delete(fn);
}

export function isBurnOverlayOpen(): boolean {
  return overlayOpen;
}

export function setBurnOverlay(open: boolean): void {
  if (overlayOpen === open) return;
  overlayOpen = open;
  for (const l of overlayListeners) l();
}
