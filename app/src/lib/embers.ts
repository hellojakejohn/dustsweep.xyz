/**
 * Embers. What `lib/burst.ts` is for a sweep, this is for a burn.
 *
 * WHY IT IS NOT `startBurst` WITH ORANGE PARTICLES. That was the first
 * attempt and it was wrong in a way that is obvious once seen: confetti
 * physics is an outward blast that arcs over and falls under gravity,
 * because confetti celebrates a thing that just landed. Fire does the
 * opposite. It rises, it slows as it cools, it wanders sideways on its
 * own draught, it flickers rather than fading smoothly, and it goes out
 * at the top instead of hitting the floor. Same palette, opposite motion,
 * and the motion is what the eye reads.
 *
 * TWO KINDS OF PARTICLE, AND THE SECOND ONE IS THE POINT.
 *
 * `spark` is the fire: small, hot, fast, many. Pure decoration.
 *
 * `smoke` is what sells it as combustion rather than as glitter. Soft,
 * dark, slow, expanding as it rises, drawn in source-over BELOW the
 * sparks so it actually occludes them -- additive smoke would glow,
 * which is the one thing smoke never does.
 *
 * `ash` carries the ticker of a token that was actually destroyed, and it
 * chars as it climbs -- tan to ember to soot -- then crumbles out near the
 * top. That is the whole event in one object: the thing had a name, the
 * name went up the flue, nothing came back. It is also the reason this
 * cannot be generic: the labels are the user's real dead tokens, read off
 * the receipt, exactly as `burst.ts` puts real tickers on its coins.
 *
 * Draws on one canvas, one rAF, tears down after itself, and takes a
 * `reduced` caller check the same way `burst.ts` does -- it does not
 * consult `prefers-reduced-motion` itself, so a caller that wants a still
 * frame can have one without this file guessing.
 */

const LIFE_MS = 3400;
const SPARKS = 70;
const Z_INDEX = 45; // above the overlay backdrop (40), below the card (50)

/** Hot core to cold soot. Index by heat, 1 = hottest. */
const HEAT = ['#3a2a22', '#8c3410', '#c05a1c', '#e8862f', '#ffb35c', '#ffd9a0'] as const;

type Spark = {
  kind: 'spark';
  x: number;
  y: number;
  vy: number;
  /** Radians into the sideways wander, and how fast it wanders. */
  phase: number;
  drift: number;
  sway: number;
  r: number;
  heat: number;
  born: number;
  life: number;
  /** Per-particle flicker clock, so no two pulse together. */
  flick: number;
};

type Smoke = {
  kind: 'smoke';
  x: number;
  y: number;
  vy: number;
  phase: number;
  drift: number;
  sway: number;
  r: number;
  born: number;
  life: number;
  seed: number;
};

type Ash = {
  kind: 'ash';
  x: number;
  y: number;
  vy: number;
  phase: number;
  drift: number;
  sway: number;
  rot: number;
  spin: number;
  label: string;
  born: number;
  life: number;
};

type Particle = Spark | Smoke | Ash;

export type EmberOpts = {
  /** Where the draught comes from. Defaults to the bottom of the
   *  viewport, so the whole page reads as the firebox. Pass a rect's
   *  centre to make the sparks come out of a specific object -- the
   *  furnace door, when it is stoked. */
  originX?: number;
  originY?: number;
  /** Horizontal spread around originX, in px. */
  spread?: number;
  sparks?: number;
  smoke?: number;
  /** Scales how hard they are thrown. 1 = a page-height updraught. */
  force?: number;
};

export function startEmbers(symbols: string[], opts?: EmberOpts): () => void {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${Z_INDEX}`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = window.innerWidth;
  let H = window.innerHeight;
  const fit = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener('resize', fit);

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  // Default origin is the bottom of the viewport: the whole page is the
  // firebox and the overlay sits in the updraught.
  const baseY = opts?.originY ?? H * 1.02;
  const baseX = opts?.originX ?? W / 2;
  const spread = opts?.spread ?? W * 0.38;
  const force = opts?.force ?? 1;
  const sparkCount = opts?.sparks ?? SPARKS;
  const smokeCount = opts?.smoke ?? Math.round(sparkCount * 0.34);

  const t0 = performance.now();
  const parts: Particle[] = [];

  for (let i = 0; i < sparkCount; i++) {
    parts.push({
      kind: 'spark',
      x: baseX + rand(-spread, spread),
      y: baseY + rand(0, 60 * force),
      // Negative is up. Faster sparks are smaller and cooler-lived.
      vy: rand(-230, -95) * force,
      phase: rand(0, Math.PI * 2),
      drift: rand(0.6, 1.9),
      sway: rand(8, 34),
      r: rand(0.8, 2.4),
      heat: rand(2.6, 5.99),
      born: t0 + rand(0, 900),
      life: rand(1500, 2700),
      flick: rand(6, 15),
    });
  }

  for (let i = 0; i < smokeCount; i++) {
    parts.push({
      kind: 'smoke',
      x: baseX + rand(-spread * 0.8, spread * 0.8),
      y: baseY + rand(-10, 40 * force),
      // Slowest thing in the scene. Smoke lags the fire that made it.
      vy: rand(-74, -30) * force,
      phase: rand(0, Math.PI * 2),
      drift: rand(0.25, 0.7),
      sway: rand(10, 40),
      r: rand(9, 22),
      born: t0 + rand(60, 700),
      life: rand(1900, 3200),
      seed: rand(0, 1),
    });
  }

  // At most a dozen names. Past that it is a wall of text on fire and
  // you cannot read any of it.
  const labels = symbols.filter((s) => s && s !== '?' && s !== '???').slice(0, 12);
  labels.forEach((label, i) => {
    parts.push({
      kind: 'ash',
      x: baseX + rand(-spread * 0.55, spread * 0.55),
      y: baseY + rand(10, 90),
      // Slower than the sparks. Paper does not shoot up a flue.
      vy: rand(-88, -46),
      phase: rand(0, Math.PI * 2),
      drift: rand(0.4, 1.1),
      sway: rand(14, 46),
      rot: rand(-18, 18),
      spin: rand(-22, 22),
      label,
      born: t0 + i * 90 + rand(0, 140),
      life: rand(2300, 3100),
    });
  });

  let raf = 0;
  let last = t0;
  let done = false;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (now - t0 > LIFE_MS) return stop();

    ctx.clearRect(0, 0, W, H);

    // PASS 1: smoke, normal blending, so it sits UNDER the fire and
    // dims what is behind it instead of adding light to it.
    ctx.globalCompositeOperation = 'source-over';
    for (const p of parts) {
      if (p.kind !== 'smoke') continue;
      const age = now - p.born;
      if (age < 0 || age > p.life) continue;
      const u = age / p.life;
      p.vy *= 1 - 0.42 * dt;
      p.y += p.vy * dt;
      p.phase += p.drift * dt;
      const x = p.x + Math.sin(p.phase) * p.sway;
      // Expands as it cools and thins out. Peaks early, then trails.
      const r = p.r * (1 + u * 2.4);
      const a = (u < 0.18 ? u / 0.18 : 1 - (u - 0.18) / 0.82) * 0.2;
      if (a <= 0.005) continue;
      const g = ctx.createRadialGradient(x, p.y, 0, x, p.y, r);
      const tint = 40 + Math.round(p.seed * 22);
      g.addColorStop(0, `rgba(${tint}, ${tint - 4}, ${tint - 8}, ${a})`);
      g.addColorStop(1, `rgba(${tint}, ${tint - 4}, ${tint - 8}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // PASS 2: fire. Additive so overlapping sparks bloom into each other
    // instead of stacking into flat opaque dots.
    ctx.globalCompositeOperation = 'lighter';

    for (const p of parts) {
      if (p.kind === 'smoke') continue;
      const age = now - p.born;
      if (age < 0 || age > p.life) continue;
      const u = age / p.life;

      // Rise, cooling as it goes: an ember slows because it is losing the
      // heat that carried it, so velocity decays rather than reversing.
      p.vy *= 1 - 0.55 * dt;
      p.y += p.vy * dt;
      p.phase += p.drift * dt;
      const x = p.x + Math.sin(p.phase) * p.sway;

      if (p.kind === 'spark') {
        // Flicker is multiplicative noise on top of a fade, not a fade on
        // its own. A smooth ramp reads as a dissolve; fire twitches.
        const fade = u < 0.12 ? u / 0.12 : 1 - (u - 0.12) / 0.88;
        const twitch = 0.62 + 0.38 * Math.sin(p.phase * p.flick);
        const a = Math.max(0, fade * twitch);
        if (a <= 0.01) continue;
        // Cools as it climbs.
        const heat = Math.max(0, p.heat - u * 2.4);
        ctx.globalAlpha = a;
        ctx.fillStyle = HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.round(heat)))]!;
        ctx.beginPath();
        ctx.arc(x, p.y, p.r * (1 - u * 0.35), 0, Math.PI * 2);
        ctx.fill();
      } else {
        p.rot += p.spin * dt;
        // Charring: legible and warm at the bottom, soot by the top, and
        // it crumbles out rather than dissolving evenly.
        const fade = u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9;
        const a = Math.max(0, fade) * 0.95;
        if (a <= 0.01) continue;
        const heat = 4.4 - u * 4.0;
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.round(heat)))]!;
        ctx.font = `600 ${13 - u * 2}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label.slice(0, 10), 0, 0);
        ctx.restore();
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(frame);
  };

  function stop() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    canvas.remove();
  }

  raf = requestAnimationFrame(frame);
  return stop;
}
