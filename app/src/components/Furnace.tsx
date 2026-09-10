import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { usePublicClient } from 'wagmi';
import { BURN_IS_LIVE, EXPLORER, SWEEP_TOKEN } from '../lib/addresses';
import {
  DEAD,
  getBurned,
  isBurnOverlayOpen,
  onBurn,
  onBurnOverlay,
  onIgnite,
  startBurnFeed,
} from '../lib/burn';
import { startEmbers } from '../lib/embers';
import { getIncinerated, onGraveyard } from '../lib/feed';
import { formatTokenAmount } from '../lib/format';

/**
 * The incinerator, hung on the wall in the top right of the room.
 *
 * The page is one workplace top to bottom: the janitor and the floor at
 * the bottom, his clipboard on the left wall, and this on the right. It
 * is where the garbage goes.
 *
 * TWO NUMBERS, AND THE ORDER IS THE ARGUMENT. The headline is dead
 * tokens destroyed through the BurnAdapter, because incinerating the
 * garbage is the janitor's actual job and roughly two thirds of a
 * typical wallet has no buyer at any price. Under it, SWEEP bought back
 * and burned, which is the receipt showing the revenue is real. A
 * project that led with the token would be a treasury operation wearing
 * a boiler suit.
 *
 * Both are read, never asserted:
 *   - incinerated  comes from the leg `adapter` field in sweep calldata
 *     that lib/feed.ts already decodes. No extra RPC call, and it
 *     inherits the plot's GRAVE_MAX window.
 *   - SWEEP burned is `balanceOf(0x…dEaD)` (lib/burn.ts), which is true
 *     whoever asks and checkable against Blockscout in ten seconds.
 *
 * THE COLD STATE IS DELIBERATE. Do not seed it, project it, or hide the
 * element until the numbers flatter. An empty furnace is a promise
 * anyone can audit; a full one that was never lit is the thing this
 * project exists to be the opposite of. Absolute figures only, never a
 * percentage of supply: early on that is a decimal with four leading
 * zeros and it reads as failure while the mechanism works.
 *
 * Two layouts, one set of markup. Above 1024px it is fixed in the margin
 * beside the 560px column with its flue running off the top of the
 * screen. Below that there is no margin, so it lies down: a wall panel in
 * the flow between the disclosure and the janitor's floor, furnace on the
 * left, readout on the right. Both are in `.furnace` in index.css. It
 * used to be `display: none` below 1024px, which meant the token had no
 * presence at all on the width most people actually arrive at.
 *
 * IGNITION. `onIgnite` fires once when a burn belonging to this user
 * lands, and drives a flare that decays back to the steady fire. It is
 * timing only: the numbers come from the chain either way, and if the
 * signal never arrives the furnace still lights on the next read.
 */
/** Long enough to read as a surge and settle, short enough that it is
 *  over before anyone reaches for a screenshot of the steady state. The
 *  tail is long and gentle on purpose: the first version snapped out of
 *  the surge and read like a dropped frame. */
const FLARE_MS = 4200;

/* --- stoking ---------------------------------------------------------
 *
 * Tapping the furnace wakes it: the bed swells, the licks speed up, the
 * sparks come faster, and it settles back. It changes NO NUMBER and it
 * costs no RPC call -- it is the same class of thing as tapping the floor
 * to drop a coin or tapping the janitor five times for a coffee break
 * (JanitorStage.tsx), and this room already works that way.
 *
 * Keep stoking and it roars: four taps inside the window and the whole
 * box goes over for longer. That is the easter egg, and like the coffee
 * break it should be findable by accident and mean nothing.
 *
 * A cold furnace stokes too. There is nothing in it, so what brightens is
 * the banked coals rather than flame -- which is exactly right, and it is
 * the only feedback a visitor with no dead tokens will ever get from
 * this element.
 */
const STOKE_MS = 1300;
const ROAR_MS = 2400;
const ROAR_TAPS = 4;
const ROAR_WINDOW_MS = 2600;

export function Furnace() {
  const client = usePublicClient();
  const [sweepBurned, setSweepBurned] = useState<bigint | null>(() => getBurned());
  const [incinerated, setIncinerated] = useState(() => getIncinerated());
  const [igniting, setIgniting] = useState(false);
  const [stoke, setStoke] = useState<'none' | 'stoked' | 'roaring'>('none');
  const [lifted, setLifted] = useState(() => isBurnOverlayOpen());
  const taps = useRef<number[]>([]);
  const stokeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const sparksRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Subscribe BEFORE starting the feed, then re-sync. Both halves
    // matter: startBurnFeed can settle synchronously (the ?burn dev
    // override does), so a listener registered afterwards misses the
    // only notification it gets; and a real async read can land between
    // first render and this effect, which the re-sync catches.
    const offBurn = onBurn(() => setSweepBurned(getBurned()));
    const offGrave = onGraveyard(() => setIncinerated(getIncinerated()));
    if (client) startBurnFeed(client);
    setSweepBurned(getBurned());
    setIncinerated(getIncinerated());
    return () => {
      offBurn();
      offGrave();
    };
  }, [client]);

  const onStoke = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = Date.now();
    taps.current = [...taps.current, now].filter((t) => now - t < ROAR_WINDOW_MS);
    const roaring = taps.current.length >= ROAR_TAPS;

    // Sparks come OUT of the door, into the room. The fire behind glass
    // is the furnace answering; this is the furnace answering loudly
    // enough that the rest of the page knows. Same particle system the
    // burn uses, aimed at the door rather than at the whole viewport, so
    // stoking and burning are visibly the same fire.
    const box = bodyRef.current?.getBoundingClientRect();
    if (box) {
      sparksRef.current?.();
      sparksRef.current = startEmbers([], {
        originX: box.left + box.width / 2,
        originY: box.top + box.height * 0.62,
        spread: box.width * 0.34,
        sparks: roaring ? 64 : 26,
        smoke: roaring ? 22 : 9,
        force: roaring ? 0.78 : 0.5,
      });
    }
    // Restart from 'none' so a tap during a running stoke actually
    // replays it instead of being swallowed by the still-present class.
    setStoke('none');
    clearTimeout(stokeTimer.current);
    requestAnimationFrame(() => {
      setStoke(roaring ? 'roaring' : 'stoked');
      stokeTimer.current = setTimeout(
        () => setStoke('none'),
        roaring ? ROAR_MS : STOKE_MS,
      );
    });
    if (roaring) taps.current = [];
  }, []);

  useEffect(
    () => () => {
      clearTimeout(stokeTimer.current);
      sparksRef.current?.();
    },
    [],
  );

  // Stay above the scrim for as long as the receipt is up, so the fire
  // and the overlay leave together instead of the fire falling into
  // shadow underneath a card that is still open.
  useEffect(() => onBurnOverlay(() => setLifted(isBurnOverlayOpen())), []);

  // The flare. One shot, self-cancelling, and skipped outright under
  // reduced motion -- where the counter still moves and the glass still
  // lights, because those are information and this is not.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onIgnite(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      setIgniting(true);
      clearTimeout(t);
      t = setTimeout(() => setIgniting(false), FLARE_MS);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  // Nothing read at all = nothing on the page. A zero that came from a
  // real read is different from not knowing, and gets a cold furnace.
  if (sweepBurned === null && incinerated === 0) return null;

  const lit = incinerated > 0 || (sweepBurned !== null && sweepBurned > 0n);

  return (
    <aside
      className={`furnace${lit ? ' is-lit' : ''}${igniting ? ' is-igniting' : ''}${
        lifted ? ' is-lifted' : ''
      }${stoke === 'stoked' ? ' is-stoked' : stoke === 'roaring' ? ' is-roaring' : ''}`}
    >
      <span className="flue" aria-hidden="true" />
      <button
        ref={bodyRef}
        type="button"
        className="furnace-body"
        onClick={onStoke}
        title="Stoke it"
        aria-label="Stoke the furnace"
      >
        <span className="furnace-rivets" aria-hidden="true" />
        <div className="furnace-door">
          <span className="furnace-window" aria-hidden="true">
            {/* Four licks on non-harmonic durations so they never resync
                into a pulse, an ember bed carrying the heat at the base,
                and three sparks. All CSS: the page already runs one rAF
                loop for the janitor and a 130x50px firebox does not
                deserve a second. */}
            {lit && (
              <>
                <span className="fire-bed" />
                <span className="flame f1" />
                <span className="flame f2" />
                <span className="flame f3" />
                <span className="flame f4" />
                <span className="spark s1" />
                <span className="spark s2" />
                <span className="spark s3" />
              </>
            )}
            {/* Banked: coals, not flame. An appliance waiting for a job
                rather than one that is switched off. Says nothing the
                readout below does not already say. */}
            {!lit && (
              <>
                <span className="ember-bed" />
                <span className="ember e1" />
                <span className="ember e2" />
              </>
            )}
          </span>
        </div>
        <span className="furnace-latch" aria-hidden="true" />
        {/* Light spilling out of the door onto the metal, on its own
            clock, so the box is never evenly lit. */}
        {lit && <span className="fire-spill" aria-hidden="true" />}
        {!lit && <span className="ember-spill" aria-hidden="true" />}
      </button>

      <div className="furnace-readout">
        <p className="num furnace-num">{incinerated}</p>
        <p className="furnace-label-static">
          dead {incinerated === 1 ? 'token' : 'tokens'} incinerated
        </p>
        <p className="furnace-note">
          {!BURN_IS_LIVE ? (
            'Not in service yet.'
          ) : sweepBurned === null ? (
            'Cold. Nothing has gone in yet.'
          ) : (
            <a
              className="furnace-label"
              href={`${EXPLORER}/token/${SWEEP_TOKEN}?tab=holders`}
              target="_blank"
              rel="noreferrer"
              title={`Verify on Blockscout: ${formatUnits(sweepBurned, 18)} SWEEP held by ${DEAD}`}
            >
              <span className="num">{formatTokenAmount(sweepBurned, 18)}</span> SWEEP burned
            </a>
          )}
        </p>
      </div>
    </aside>
  );
}
