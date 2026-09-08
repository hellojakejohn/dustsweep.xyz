import { useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  getGraveyard,
  getGraveyardOlder,
  getLast,
  getTotal,
  onGraveyard,
  onSweep,
  onTotal,
  startFeed,
  type Headstone,
  type LastSweep,
  type SweepEvent,
} from '../lib/feed';
import { formatEthTrim } from '../lib/format';
import { useBusy } from '../lib/mood';
import {
  FIGURE_H,
  FLOOR_Y,
  drawJanitor,
  leanPose,
  loadParts,
  sweepPose,
  walkPose,
  type Parts,
} from '../lib/puppet';

/**
 * The bottom strip. Dead tokens land on the floor, the janitor walks to
 * the nearest one and sweeps it off the edge, and he never finishes.
 * That is the joke and it is also just true: two launchpads shipped
 * ~63,000 tokens onto this chain and then went dark.
 *
 * Three things drop coins:
 *   - ambient trickle, faster while the app is scanning or sweeping
 *   - a tap anywhere on the floor
 *   - real sweeps on mainnet, read off the Sweeper's `Swept` events, one
 *     coin per token with its symbol on it (lib/feed.ts)
 *
 * Decoration only. Nothing here touches the scan or the sell path. It
 * reads one shared bit (`useBusy`) and the public read client.
 *
 * Implementation: an imperative little physics loop that owns its own
 * DOM. React renders the shell, the counter and nothing else; per-frame
 * work writes transforms directly. Coins are gravity + a floor bounce +
 * rolling friction; the broom is an impulse. He is a rig drawn on a
 * canvas (lib/puppet.ts): joint angles from time and state, not frames.
 * Honours reduced motion by freezing to a still.
 */

/* ---------- sprites ------------------------------------------------- */

/**
 * Default renderer: five hand-generated frames. The canvas rig in
 * lib/puppet.ts is kept behind ?rig for tuning; it is not good enough to
 * ship yet (pivot calibration, part overlap). ?rig=lineup draws the
 * static pose sheet.
 */
const WALK_FRAMES = ['/janitor/walk-1.png?v=3', '/janitor/walk-2.png?v=3'];
const SWEEP_FRAMES = ['/janitor/sweep-1.png?v=3', '/janitor/sweep-2.png?v=3', '/janitor/sweep-3.png?v=3'];
const LEAN_FRAME = '/janitor-solo.png';
const SWEEP_MS = 720;
/** Frame canvas aspect (341x400). */
const FRAME_ASPECT = 0.8525;
/** Frames per stride, matched to distance so the feet do not slide. */
const STRIDE_FRAMES = 2;

const RIG_PARAM =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('rig') : null;
const USE_RIG = RIG_PARAM !== null;
const RIG_LINEUP = RIG_PARAM === 'lineup';

/* ---------- tuning -------------------------------------------------- */

export const COLORS = ['#d8b377', '#e49054', '#c9bda8', '#8f9c80', '#5c7a72', '#b8834f'];
const MAX_COINS = 80;
const WALK_PX_S = 58;
const HURRY = 1.9;
const GRAVITY = 1100;
/** How far in front of his feet the broom reaches, as a fraction of his width. */
const BROOM_REACH = 0.34;
/** Seconds with nothing to do before he stops and leans. */
const IDLE_AFTER_S = 11;

const IDLE_LINES = [
  '63,000.',
  'Somebody had to.',
  'Still here.',
  'They keep launching them.',
  'Two launchpads. Zero front ends.',
  'It is a living.',
  'No route out. Story of my life.',
  'One signature. That is all I ask.',
];
const BREAK_LINES = ['coffee.', '...', 'five minutes.', 'fine.'];

/* ---------- component ----------------------------------------------- */
// The counter used to be an odometer pinned top right. Since 8 Sep it is
// the header of the graveyard strip on the LEFT (see Graveyard below),
// and the engine keeps him and the coins out of that strip via --grave-w.

export function JanitorStage() {
  const reduced = useReducedMotion();
  return (
    <div
      aria-hidden="true"
      className="janitor-stage relative mt-auto w-full select-none overflow-hidden"
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-teal/25 via-teal/[0.06] to-transparent" />
      <div className="floor pointer-events-none absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cream/15 to-transparent" />
      {reduced ? <StaticScene /> : <LiveScene />}
    </div>
  );
}

function LiveScene() {
  const client = usePublicClient();
  const busy = useBusy();
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const rootRef = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState(getTotal());
  const [last, setLast] = useState(getLast());

  // Live feed. Starts once per page, survives re-renders.
  useEffect(() => {
    if (client) startFeed(client);
    return onTotal(() => {
      setTotal(getTotal());
      setLast(getLast());
    });
  }, [client]);

  // The engine. Built once; reads busy through the ref.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const engine = createEngine(root, () => busyRef.current);
    const off = onSweep((e) => engine.dropSweep(e));
    return () => {
      off();
      engine.destroy();
    };
  }, []);

  return (
    <>
      <div ref={rootRef} className="absolute inset-0 touch-manipulation" />
      <Graveyard total={total.total} complete={total.complete} last={last} />
    </>
  );
}

/** How many stones stand in the plot at once. Older ones fade, then go;
 *  the odometer still counts them. Fewer on a phone, where the strip is
 *  two stones wide and the stage is 172px tall. */
function graveVisible(): number {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 12 : 4;
}

/**
 * The graveyard. A strip down the left edge of the stage: the odometer
 * and its label up top, the plot of headstones standing on the floor
 * below, one stone per token the Sweeper has actually sold, ticker read
 * off the chain. Newest nearest the janitor, rows wrapping upward.
 *
 * Real data only. If the chain has two stones in it, there are two
 * stones. Nothing is seeded, padded or drawn dim behind it. The ~63,000
 * dead tokens on this chain are a real number and a real future feature
 * (the offline TokenDeployed index), and until that index exists nothing
 * that was not read off the chain goes on this screen.
 *
 * The odometer counts every `legsFilled` in every Swept log and can
 * legitimately exceed the number of stones once the hydration cap
 * bites; then the plot shows what it has and says `+N older`.
 */
function Graveyard({
  total,
  complete,
  last,
}: {
  total: number;
  complete: boolean;
  last: LastSweep | null;
}) {
  // Re-render every 30s so "4m ago" keeps moving without a feed event.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const [stones, setStones] = useState<Headstone[]>(() => [...getGraveyard()]);
  const [older, setOlder] = useState(getGraveyardOlder());
  useEffect(
    () =>
      onGraveyard(() => {
        setStones([...getGraveyard()]);
        setOlder(getGraveyardOlder());
      }),
    [],
  );
  // Stones that were already standing when this render tree mounted do
  // not rise again on a re-render; only ones that arrive later do.
  const seen = useRef(new Set(stones.map((h) => h.txHash)));

  if (total === 0 && !complete) return null;

  const visible = stones.slice(-graveVisible());
  const hidden = stones.length - visible.length + older;

  return (
    <div className="graveyard pointer-events-none absolute inset-y-0 left-0">
      <div className="grave-head px-2 pt-3 pb-2 sm:px-2.5 sm:pt-4">
        <p className="num text-[18px] font-semibold leading-none text-tan sm:text-[22px]">
          <Odometer value={total} />
        </p>
        <p className="mt-1 text-[10.5px] leading-snug text-faint">
          dead {total === 1 ? 'token' : 'tokens'} swept
          {complete ? ' since launch' : ' lately'}
          {total === 0 ? '. Yet.' : ''}
        </p>
        {/* Three short lines rather than one that wraps mid-number: the
            strip is 120px wide and "0.00233 ETH · 12h ago" is not. */}
        {last && (
          <p className="num mt-1.5 text-[10px] leading-snug text-faint/80">
            <span className="block">
              last: <span className="text-muted">{lastSymbols(last)}</span>
            </span>
            <span className="block">{formatEthTrim(last.userOutWei)} ETH</span>
            <span className="block">{ago(last.at)}</span>
          </p>
        )}
      </div>

      {/* Newest first in the DOM; row-reverse puts it on the right, next
          to the janitor, and wrap-reverse stacks the older rows upward. */}
      <div className="grave-plot-wrap">
        <div className="grave-plot">
          {[...visible].reverse().map((h, i) => {
            const fresh = !seen.current.has(h.txHash);
            if (fresh) seen.current.add(h.txHash);
            // Oldest of the visible fade out toward the cap.
            const fade = Math.max(0.35, 1 - Math.max(0, i - 3) * 0.09);
            return (
              <span
                key={`${h.txHash}-${h.token}`}
                className={`stone${fresh ? ' stone-rise' : ''}`}
                style={{ opacity: fade }}
                title={h.symbol}
              >
                <span>{h.symbol}</span>
              </span>
            );
          })}
        </div>
      </div>
      {hidden > 0 && (
        <p className="grave-older num text-[9px] leading-none text-faint/80">+{hidden} older</p>
      )}
    </div>
  );
}

/** "TOAD" / "TOAD +2" / "2 tokens" when the calldata could not be read. */
function lastSymbols(l: LastSweep): string {
  const [first, ...rest] = l.symbols.filter((x) => x && x !== '?');
  if (!first) return `${l.legsFilled} ${l.legsFilled === 1 ? 'token' : 'tokens'}`;
  return rest.length ? `${first} +${rest.length}` : first;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Gas-pump digits. Each digit is a 10-tall column that slides to the
 * right number, so a live sweep rolls the counter instead of blinking
 * it. Keyed from the right so a new leading digit does not reshuffle
 * the ones already showing. Static under reduced motion (CSS).
 */
function Odometer({ value }: { value: number }) {
  const chars = [...value.toLocaleString()];
  return (
    <span className="odo" aria-label={value.toLocaleString()}>
      {chars.map((ch, i) => {
        const key = chars.length - i;
        if (!/\d/.test(ch)) return <span key={key}>{ch}</span>;
        return (
          <span key={key} className="odo-digit">
            <span className="odo-col" style={{ transform: `translateY(-${Number(ch) * 10}%)` }}>
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/* ---------- engine -------------------------------------------------- */

type Coin = {
  el: HTMLDivElement;
  tag: HTMLSpanElement | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  w: number;
  h: number;
  resting: boolean;
  sweptAt: number; // ms, or 0
};

type Mode = 'walk' | 'idle' | 'break';

function createEngine(root: HTMLDivElement, isBusy: () => boolean) {
  /* DOM ------------------------------------------------------------- */
  const coinsLayer = el('div', 'absolute inset-0');
  const canvas = document.createElement('canvas');
  canvas.className = 'janitor-canvas absolute inset-0';
  const ctx = canvas.getContext('2d')!;
  const bubble = el('div', 'janitor-bubble');
  bubble.hidden = true;
  const sprite = el('div', 'janitor-walk absolute left-0 top-0');
  const img = document.createElement('img');
  img.className = 'janitor-img block w-auto';
  img.draggable = false;
  img.alt = '';
  img.src = WALK_FRAMES[0]!;
  sprite.append(img);
  root.append(coinsLayer, USE_RIG ? canvas : sprite, bubble);
  let parts: Parts | null = null;
  if (USE_RIG) void loadParts().then((p) => (parts = p));
  for (const src of [...WALK_FRAMES, ...SWEEP_FRAMES, LEAN_FRAME]) {
    const i = new Image();
    i.src = src;
  }
  let lastSrc = '';
  let lastFlip = 0;
  const setFrame = (src: string) => {
    if (src !== lastSrc) {
      img.src = src;
      lastSrc = src;
    }
  };
  const face = (d: number) => {
    if (d !== lastFlip) {
      img.style.transform = d === 1 ? 'scaleX(-1)' : 'scaleX(1)';
      lastFlip = d;
    }
  };

  /* geometry -------------------------------------------------------- */
  let W = root.clientWidth;
  let H = root.clientHeight;
  let floorY = H - cssPx(root, '--floor', 24);
  let jH = cssPx(root, '--janitor-h', 150);
  let jW = jH * (USE_RIG ? 0.62 : FRAME_ASPECT); // footprint, for hit tests and reach
  // The graveyard strip on the left. He does not walk through it and
  // coins do not land in it; `--grave-w` is the left bound of the floor.
  let graveW = cssPx(root, '--grave-w', 0);
  const coins: Coin[] = [];
  const fit = () => {
    W = root.clientWidth;
    H = root.clientHeight;
    floorY = H - cssPx(root, '--floor', 24);
    jH = cssPx(root, '--janitor-h', 150);
    jW = jH * (USE_RIG ? 0.62 : FRAME_ASPECT);
    graveW = cssPx(root, '--grave-w', 0);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const c of coins) if (c.resting) c.y = floorY - c.h / 2;
  };
  const ro = new ResizeObserver(fit);
  ro.observe(root);
  fit();

  /* state ----------------------------------------------------------- */
  let jx = graveW + (W - graveW) * (0.3 + Math.random() * 0.4);
  let dir: -1 | 1 = -1;
  let mode: Mode = 'walk';
  let sweepStart = -1e9;
  let sweepHitDone = true;
  let walkPhase = 0;
  let look = 0;
  let pointer: { x: number; y: number } | null = null;
  let lastUseful = performance.now();
  let idleLineAt = 0;
  let idleLineIdx = Math.floor(Math.random() * IDLE_LINES.length);
  let breakUntil = 0;
  let breakStep = -1;
  let clicks: number[] = [];
  let nextSpawn = performance.now() + 700;
  let raf = 0;
  let last = performance.now();

  // A dozen already on the floor. He was working before you got here.
  for (let i = 0; i < 12; i++) {
    const c = spawn(floorX(Math.random()), null);
    c.y = floorY - c.h / 2;
    c.vy = 0;
    c.vx = 0;
    c.resting = true;
    place(c);
  }

  /* input ----------------------------------------------------------- */
  const onDown = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // On him? Five taps in six seconds earns him a break.
    if (Math.abs(x - jx) < jW * 0.4 && y > floorY - jH && y < floorY) {
      const now = performance.now();
      clicks = clicks.filter((t) => now - t < 6000);
      clicks.push(now);
      if (clicks.length >= 5 && mode !== 'break') {
        clicks = [];
        mode = 'break';
        breakUntil = now + 9000;
        breakStep = -1;
      }
      return;
    }
    if (x < graveW) return; // the plot is not the floor
    spawn(x, null, true);
    wake();
  };
  root.addEventListener('pointerdown', onDown);
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onLeave = () => (pointer = null);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerleave', onLeave);

  /* coins ----------------------------------------------------------- */
  function spawn(x: number, label: string | null, fromTap = false): Coin {
    const live = coins.filter((c) => !c.sweptAt).length;
    if (live >= MAX_COINS) {
      // Recycle the oldest resting one so taps always do something.
      const old = coins.find((c) => c.resting && !c.sweptAt);
      if (old) remove(old);
    }
    const w = 14 + Math.round(Math.random() * 12);
    const h = Math.max(5, Math.round(w * 0.42));
    const d = el('div', 'coin') as HTMLDivElement;
    d.style.width = `${w}px`;
    d.style.height = `${h}px`;
    d.style.background = COLORS[Math.floor(Math.random() * COLORS.length)]!;
    let tag: HTMLSpanElement | null = null;
    if (label) {
      tag = el('span', 'coin-tag') as HTMLSpanElement;
      tag.textContent = label;
      d.append(tag);
      d.style.zIndex = '3';
    }
    coinsLayer.append(d);
    const c: Coin = {
      el: d,
      tag,
      x: Math.min(W - w, Math.max(graveW + w, x)),
      y: fromTap ? -h : -h - Math.random() * 60,
      vx: (Math.random() - 0.5) * 30,
      vy: 0,
      rot: 0,
      spin: 0,
      w,
      h,
      resting: false,
      sweptAt: 0,
    };
    coins.push(c);
    return c;
  }

  function place(c: Coin) {
    c.el.style.transform = `translate(${c.x - c.w / 2}px, ${c.y - c.h / 2}px) rotate(${c.rot}deg)`;
  }

  function remove(c: Coin) {
    c.el.remove();
    const i = coins.indexOf(c);
    if (i >= 0) coins.splice(i, 1);
  }

  /** A point on the sweepable floor, `u` in [0,1] from the graveyard's
   *  edge to the right edge. */
  function floorX(u: number): number {
    return graveW + (W - graveW) * u;
  }

  function dropSweep(e: SweepEvent) {
    const n = Math.max(e.legsFilled, e.symbols.length, 1);
    for (let i = 0; i < Math.min(n, 24); i++) {
      const label = e.symbols[i] ?? null;
      setTimeout(() => {
        spawn(floorX(0.08 + Math.random() * 0.84), label);
        wake();
      }, i * 140);
    }
  }

  function puff(x: number) {
    const p = el('div', 'puff');
    p.style.left = `${x}px`;
    p.style.top = `${floorY - 6}px`;
    coinsLayer.append(p);
    p.addEventListener('animationend', () => p.remove(), { once: true });
  }

  /* janitor --------------------------------------------------------- */
  function say(text: string) {
    bubble.textContent = text;
    bubble.hidden = false;
  }
  function hush() {
    bubble.hidden = true;
  }
  function wake() {
    if (mode === 'idle') {
      mode = 'walk';
      hush();
    }
    lastUseful = performance.now();
  }
  /* loop ------------------------------------------------------------ */
  // dustsweep.xyz/?rig=lineup draws a static pose lineup instead of running.
  const RIG_DEBUG = RIG_LINEUP;

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const busy = isBusy();

    if (RIG_DEBUG) {
      ctx.clearRect(0, 0, W, H);
      if (parts) {
        const poses = [
          walkPose(0, 0, 0),
          walkPose(Math.PI / 2, 0, 0),
          walkPose(Math.PI, 0, 0),
          sweepPose(0.15, 0),
          sweepPose(0.5, 0),
          sweepPose(0.95, 0),
          leanPose(0.25, 0),
          walkPose(Math.PI / 2, 1, 8),
        ];
        const sc = jH / FIGURE_H;
        poses.forEach((pose, i) => {
          ctx.save();
          ctx.translate((W * (i + 0.5)) / poses.length, floorY);
          ctx.scale(i === poses.length - 1 ? -sc : sc, sc);
          ctx.translate(0, -FLOOR_Y);
          drawJanitor(ctx, parts!, pose);
          ctx.restore();
        });
      }
      raf = requestAnimationFrame(frame);
      return;
    }

    // Spawn trickle.
    if (now >= nextSpawn) {
      spawn(floorX(0.04 + Math.random() * 0.92), null);
      nextSpawn = now + (busy ? 240 + Math.random() * 200 : 1100 + Math.random() * 1600);
    }

    // Physics.
    for (const c of [...coins]) {
      if (c.sweptAt) {
        const age = now - c.sweptAt;
        if (age > 1100 || c.x < -60 || c.x > W + 60) {
          remove(c);
          continue;
        }
        c.el.style.opacity = String(Math.max(0, 1 - age / 1100));
      }
      if (!c.resting) {
        c.vy += GRAVITY * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.spin * dt;
        const fy = floorY - c.h / 2;
        if (c.y >= fy && !c.sweptAt) {
          c.y = fy;
          if (c.vy > 90) {
            c.vy = -c.vy * 0.32;
            c.vx *= 0.7;
            c.spin *= 0.5;
          } else {
            c.vy = 0;
            c.spin = 0;
            c.rot = 0;
          }
          c.vx *= Math.max(0, 1 - 3.2 * dt); // rolling friction
          if (Math.abs(c.vx) < 6 && c.vy === 0) {
            c.vx = 0;
            c.resting = true;
            if (c.tag) {
              const tag = c.tag;
              setTimeout(() => tag.classList.add('is-gone'), 2600);
            }
          }
        }
        place(c);
      }
    }

    // Janitor brain.
    const resting = coins.filter((c) => c.resting && !c.sweptAt);
    if (resting.length > 0) lastUseful = now;

    // Where is he looking? Toward the cursor if it is near, else ahead.
    const headX = jx - dir * jH * 0.02;
    const headY = floorY - jH * 0.86;
    let lookTarget = 0;
    if (pointer) {
      const dx = (pointer.x - headX) * -dir; // positive = in front of him
      const dy = pointer.y - headY;
      if (Math.abs(dx) < W * 0.5) lookTarget = Math.max(-14, Math.min(14, (Math.atan2(dy, Math.abs(dx) + 40) * 180) / Math.PI * 0.6));
    }
    look += (lookTarget - look) * Math.min(1, dt * 6);

    let pose;
    let movedThisFrame = false;
    const sweepU = (now - sweepStart) / SWEEP_MS;
    const sweeping = sweepU < 1;

    if (mode === 'break') {
      const step = Math.min(BREAK_LINES.length - 1, Math.floor((9000 - (breakUntil - now)) / 2200));
      if (step !== breakStep) {
        breakStep = step;
        say(BREAK_LINES[step]!);
      }
      if (now > breakUntil) {
        mode = 'walk';
        hush();
      }
      pose = leanPose((now / 3600) % 1, look);
    } else if (mode === 'idle') {
      if (now - idleLineAt > 9000) {
        idleLineAt = now;
        idleLineIdx = (idleLineIdx + 1) % IDLE_LINES.length;
        say(IDLE_LINES[idleLineIdx]!);
        setTimeout(() => {
          if (mode === 'idle') hush();
        }, 4200);
      }
      if (resting.length > 0) wake();
      pose = leanPose((now / 3600) % 1, look);
    } else {
      // Walk toward the nearest resting coin; wander if there is none.
      let target: number | null = null;
      if (resting.length > 0) {
        let best = Infinity;
        for (const c of resting) {
          const d = Math.abs(c.x - jx);
          if (d < best) {
            best = d;
            target = c.x;
          }
        }
      }
      const speed = WALK_PX_S * (busy ? HURRY : 1);
      const reach = jW * BROOM_REACH;
      let moved = 0;
      if (!sweeping) {
        if (target !== null) {
          const side: -1 | 1 = target >= jx ? 1 : -1;
          dir = side;
          const dist = Math.abs(target - jx);
          const want = reach * 0.8;
          if (dist > want) {
            moved = Math.min(dist - want, speed * dt);
            jx += side * moved;
          }
        } else {
          moved = speed * 0.45 * dt;
          jx += dir * moved;
          if (jx < graveW + jW * 0.6) dir = 1;
          if (jx > W - jW * 0.6) dir = -1;
          if (now - lastUseful > IDLE_AFTER_S * 1000) {
            mode = 'idle';
            idleLineAt = 0;
          }
        }
      }
      // Stride length scales with his size so the feet stay planted.
      walkPhase += (moved / (jH * 0.55)) * Math.PI * 2;
      movedThisFrame = moved > 0;

      // Broom contact. Start a stroke when something is in reach; the
      // coins leave at the contact point of the swing, not on frame one.
      const inReach = resting.filter((c) => {
        const ahead = (c.x - jx) * dir;
        return ahead > -jW * 0.06 && ahead < reach + c.w / 2;
      });
      if (!sweeping && inReach.length > 0) {
        sweepStart = now;
        sweepHitDone = false;
      }
      if (!sweepHitDone && sweepU >= 0.42) {
        sweepHitDone = true;
        let hit = false;
        for (const c of inReach) {
          c.resting = false;
          c.sweptAt = now;
          c.vx = dir * (240 + Math.random() * 160);
          c.vy = -(160 + Math.random() * 140);
          c.spin = dir * (500 + Math.random() * 400);
          c.el.style.zIndex = '5';
          hit = true;
        }
        if (hit) puff(jx + dir * reach);
      }

      const hurry = busy ? 1 : 0;
      pose = sweeping
        ? sweepPose(sweepU, look)
        : moved > 0
          ? walkPose(walkPhase, hurry, look)
          : leanPose((now / 3600) % 1, look);
    }

    // Draw him.
    if (USE_RIG) {
      ctx.clearRect(0, 0, W, H);
      if (parts) {
        const sc = jH / FIGURE_H;
        ctx.save();
        ctx.translate(jx, floorY);
        ctx.scale(dir === 1 ? -sc : sc, sc);
        ctx.translate(0, -FLOOR_Y);
        drawJanitor(ctx, parts, pose);
        ctx.restore();
      }
    } else {
      face(dir);
      if (mode !== 'walk' || (!sweeping && !movedThisFrame)) setFrame(LEAN_FRAME);
      else if (sweeping) {
        const i = Math.min(SWEEP_FRAMES.length - 1, Math.floor(sweepU * SWEEP_FRAMES.length));
        setFrame(SWEEP_FRAMES[i]!);
      } else {
        const i = Math.floor((walkPhase / (Math.PI * 2)) * STRIDE_FRAMES * WALK_FRAMES.length) % WALK_FRAMES.length;
        setFrame(WALK_FRAMES[((i % WALK_FRAMES.length) + WALK_FRAMES.length) % WALK_FRAMES.length]!);
      }
      sprite.style.transform = `translate(${jx}px, ${floorY - jH + 4}px) translateX(-50%)`;
    }
    // Bubble rides beside his head.
    bubble.style.left = `${headX + jH * 0.22}px`;
    bubble.style.top = `${headY - jH * 0.1}px`;

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    dropSweep,
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      coinsLayer.remove();
      canvas.remove();
      sprite.remove();
      bubble.remove();
    },
  };
}

/* ---------- helpers ------------------------------------------------- */

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function cssPx(node: Element, name: string, fallback: number): number {
  const v = parseFloat(getComputedStyle(node).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
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

/** Reduced motion: the same scene, frozen. He has already stopped. */
function StaticScene() {
  const coins = useRef(
    Array.from({ length: 16 }, () => ({
      x: 3 + Math.random() * 94,
      w: 14 + Math.round(Math.random() * 12),
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    })),
  ).current;
  return (
    <>
      {coins.map((c, i) => (
        <i
          key={i}
          className="coin coin-still"
          style={{
            left: `${c.x}%`,
            width: c.w,
            height: Math.max(5, Math.round(c.w * 0.42)),
            background: c.color,
          }}
        />
      ))}
      <div
        className="janitor-walk absolute"
        style={{ left: '84%', bottom: 'calc(var(--floor) - 4px)', transform: 'translateX(-50%)' }}
      >
        <img src={LEAN_FRAME} alt="" draggable={false} className="janitor-img block w-auto" />
      </div>
    </>
  );
}
