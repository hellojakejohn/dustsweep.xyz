import { useEffect, useRef, useState } from 'react';
import { useBusy } from '../lib/mood';

/**
 * The bottom strip. Dead tokens rain onto the floor, the janitor paces the
 * width of the screen, and whatever he walks through gets swept off the
 * edge. He never finishes. That is the joke and it is also just true:
 * two launchpads shipped ~63,000 tokens here and then went dark.
 *
 * Decoration only. Nothing here touches the scan or the sweep; it reads
 * one shared bit (`useBusy`) so the coins fall faster while the app is
 * working, which doubles as the loading state.
 *
 * Performance: the janitor's position is written straight to the DOM from
 * a requestAnimationFrame loop, never through React state. Coins only
 * re-render when one spawns or gets swept, a few times a second at most.
 * Everything animated is transform/opacity, so it stays on the compositor.
 *
 * Honours prefers-reduced-motion by freezing to a static scene.
 */

type CoinState = 'falling' | 'resting' | 'swept';
type Coin = {
  id: number;
  /** Horizontal position, percent of stage width. */
  x: number;
  /** Diameter in px. */
  size: number;
  color: string;
  /** Small per-coin offset so a pile does not sit on one pixel line. */
  lift: number;
  state: CoinState;
  /** Direction the broom pushed it: -1 left, 1 right. */
  dir: -1 | 1;
};

/** Coin palette, sampled from the banner artwork. Red stays off the floor. */
const COLORS = ['#d8b377', '#e49054', '#c9bda8', '#8f9c80', '#5c7a72', '#b8834f'];

const MAX_COINS = 70;
/** Seconds for one full left-to-right-to-left lap. */
const LAP_SECONDS = 26;
/** Percent of stage width the janitor walks between, centre of his feet. */
const WALK_MIN = 6;
const WALK_MAX = 92;
/** How far (percent) in front of him the broom reaches. */
const BROOM_REACH = 3.5;

/**
 * Sprite frames. Drop PNGs into app/public/janitor/ and list them here.
 * Rules in app/public/janitor/README.md: same canvas size, feet on the
 * same line, facing the same way. With one entry he glides; with two or
 * more he walks. SWEEP_FRAMES play instead while he is knocking coins
 * off the floor; leave it empty to use the walk cycle for that too.
 */
const WALK_FRAMES: string[] = ['/janitor/walk-1.png', '/janitor/walk-2.png'];
const SWEEP_FRAMES: string[] = [
  '/janitor/sweep-1.png', // wind-up, broom back behind him
  '/janitor/sweep-2.png', // contact, broom at his feet
  '/janitor/sweep-3.png', // follow-through, broom out in front
];
/** Milliseconds per frame. 8 fps reads as a walk without looking twitchy. */
const FRAME_MS = 125;

let nextId = 1;

function spawnCoin(): Coin {
  return {
    id: nextId++,
    x: 3 + Math.random() * 94,
    size: 14 + Math.round(Math.random() * 12),
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    lift: Math.round(Math.random() * 9),
    state: 'falling',
    dir: 1,
  };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function JanitorStage() {
  const reduced = useReducedMotion();
  return (
    <div
      aria-hidden="true"
      className="janitor-stage pointer-events-none relative mt-auto w-full select-none overflow-hidden"
    >
      {/* Floor glow: teal lifted off the page so the strip reads as a
          place, not a smear. Fades to nothing above the coins. */}
      <div className="absolute inset-0 bg-gradient-to-t from-teal/25 via-teal/[0.06] to-transparent" />
      <div className="floor absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cream/15 to-transparent" />
      {reduced ? <StaticScene /> : <LiveScene />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LiveScene() {
  const busy = useBusy();
  // A few already on the floor at load. He was working before you got here.
  const [coins, setCoins] = useState<Coin[]>(() =>
    Array.from({ length: 12 }, () => ({ ...spawnCoin(), state: 'resting' as const })),
  );
  const coinsRef = useRef<Coin[]>([]);
  coinsRef.current = coins;

  const janitorRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLImageElement>(null);

  // Spawn loop. Faster while the app is working.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setCoins((prev) => {
        const live = prev.filter((c) => c.state !== 'swept').length;
        if (live >= MAX_COINS) return prev;
        return [...prev, spawnCoin()];
      });
      const gap = busy ? 240 + Math.random() * 200 : 900 + Math.random() * 1100;
      timer = setTimeout(tick, gap);
    };
    timer = setTimeout(tick, busy ? 200 : 900);
    return () => clearTimeout(timer);
  }, [busy]);

  // Warm the frame cache so the first cycle does not flicker.
  useEffect(() => {
    for (const src of [...WALK_FRAMES, ...SWEEP_FRAMES]) {
      const img = new Image();
      img.src = src;
    }
  }, []);

  // Walk loop. Triangle wave across the stage; flip the sprite on turn.
  useEffect(() => {
    let raf = 0;
    let lastDir: -1 | 0 | 1 = 0;
    let lastSrc = '';
    // A sweep burst plays every SWEEP_FRAME once, in order, then returns
    // to the walk. Retriggering mid-burst restarts it from the wind-up.
    let sweepStart = -Infinity;
    const SWEEP_FRAME_MS = FRAME_MS * 2;
    const sweepLen = SWEEP_FRAMES.length * SWEEP_FRAME_MS;
    const start = performance.now() - Math.random() * LAP_SECONDS * 1000;
    const span = WALK_MAX - WALK_MIN;

    const frame = (now: number) => {
      const t = ((now - start) / 1000 / LAP_SECONDS) % 1; // 0..1
      // 0 -> 0.5 walks right, 0.5 -> 1 walks left.
      const goingRight = t < 0.5;
      const p = goingRight ? t * 2 : (1 - t) * 2;
      // Ease at the ends so the turn is not a snap.
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const x = WALK_MIN + eased * span;
      const dir: -1 | 1 = goingRight ? 1 : -1;

      const el = janitorRef.current;
      if (el) el.style.left = `${x}%`;
      if (dir !== lastDir && flipRef.current) {
        // Art faces broom-left. Walking right, the broom should lead, so
        // we flip when heading right and leave him as drawn heading left.
        flipRef.current.style.transform = dir === 1 ? 'scaleX(-1)' : 'scaleX(1)';
        lastDir = dir;
      }

      // Sweep: any resting coin inside broom reach, in front of him.
      const reachLo = dir === 1 ? x : x - BROOM_REACH;
      const reachHi = dir === 1 ? x + BROOM_REACH : x;
      const hit = coinsRef.current.filter(
        (c) => c.state === 'resting' && c.x >= reachLo && c.x <= reachHi,
      );
      if (hit.length > 0) {
        const ids = new Set(hit.map((c) => c.id));
        setCoins((prev) =>
          prev.map((c) => (ids.has(c.id) ? { ...c, state: 'swept', dir } : c)),
        );
        sweepStart = now;
      }

      // Frame cycling. Only writes to the DOM when the frame changes.
      const sweeping = SWEEP_FRAMES.length > 0 && now - sweepStart < sweepLen;
      if (WALK_FRAMES.length + SWEEP_FRAMES.length > 1 && flipRef.current) {
        const src = sweeping
          ? SWEEP_FRAMES[Math.min(SWEEP_FRAMES.length - 1, Math.floor((now - sweepStart) / SWEEP_FRAME_MS))]!
          : WALK_FRAMES[Math.floor(now / FRAME_MS) % WALK_FRAMES.length]!;
        if (src !== lastSrc) {
          flipRef.current.src = src;
          lastSrc = src;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const land = (id: number) =>
    setCoins((prev) => prev.map((c) => (c.id === id ? { ...c, state: 'resting' } : c)));
  const remove = (id: number) => setCoins((prev) => prev.filter((c) => c.id !== id));

  return (
    <>
      {coins.map((c) => (
        <i
          key={c.id}
          className={`coin coin-${c.state}`}
          style={
            {
              left: `${c.x}%`,
              width: c.size,
              height: Math.max(5, Math.round(c.size * 0.42)),
              background: c.color,
              '--lift': `${c.lift}px`,
              '--dir': c.dir,
            } as React.CSSProperties
          }
          onAnimationEnd={() => {
            if (c.state === 'falling') land(c.id);
            else if (c.state === 'swept') remove(c.id);
          }}
        />
      ))}

      <div ref={janitorRef} className="janitor-walk absolute bottom-0" style={{ left: '50%' }}>
        <div className={WALK_FRAMES.length > 1 ? undefined : 'janitor-bob'}>
          <img
            ref={flipRef}
            src={WALK_FRAMES[0]}
            alt=""
            draggable={false}
            className="janitor-img block w-auto"
          />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Reduced motion: the same scene, frozen. He has already stopped. */
function StaticScene() {
  const coins = useRef<Coin[]>(
    Array.from({ length: 16 }, () => ({ ...spawnCoin(), state: 'resting' as const })),
  ).current;
  return (
    <>
      {coins.map((c) => (
        <i
          key={c.id}
          className="coin coin-resting coin-still"
          style={
            {
              left: `${c.x}%`,
              width: c.size,
              height: Math.max(5, Math.round(c.size * 0.42)),
              background: c.color,
              '--lift': `${c.lift}px`,
            } as React.CSSProperties
          }
        />
      ))}
      <div className="janitor-walk absolute bottom-0" style={{ left: '84%' }}>
        <img src={WALK_FRAMES[0]} alt="" draggable={false} className="janitor-img block w-auto" />
      </div>
    </>
  );
}
