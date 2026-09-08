/**
 * One-shot confetti. A fixed, pointer-events-none canvas over the whole
 * viewport, about 90 particles, gone after roughly 2.2s. It cancels its
 * own rAF and removes its own canvas; nothing keeps running after it.
 *
 * Physics is the coin engine's (components/JanitorStage.tsx): gravity,
 * drag, spin. A handful of the particles are coin discs carrying the
 * symbols the user actually swept, so the burst is made of the tokens
 * that just died and not of generic glitter.
 *
 * Callers check `prefers-reduced-motion` before calling this. It does
 * not check for itself, so a caller that wants a still frame can have
 * one without this file guessing.
 */

const LIFE_MS = 2200;
const COUNT = 90;
const GRAVITY = 1100;
const DRAG = 1.6;
const Z_INDEX = 45; // above the overlay backdrop (40), below the card (50)

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  w: number;
  h: number;
  color: string;
  label: string | null;
};

export function startBurst(symbols: string[], colors: readonly string[]): () => void {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${Z_INDEX}`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = window.innerWidth;
  let H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const ox = W / 2;
  const oy = H * 0.42;
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]!;
  const labels = symbols.filter((s) => s && s !== '?').slice(0, 24);

  const parts: Particle[] = [];
  for (let i = 0; i < COUNT; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const sp = 420 + Math.random() * 520;
    const coin = labels.length > 0 && i < Math.min(labels.length, 10);
    const w = coin ? 30 + Math.random() * 10 : 6 + Math.random() * 8;
    parts.push({
      x: ox + (Math.random() - 0.5) * 40,
      y: oy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: Math.random() * 360,
      spin: (Math.random() - 0.5) * 720,
      w,
      h: coin ? w : 4 + Math.random() * 6,
      color: pick(colors),
      label: coin ? labels[i]! : null,
    });
  }

  let raf = 0;
  const t0 = performance.now();
  let last = t0;
  let done = false;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - t0;
    if (age > LIFE_MS) return stop();

    const fade = age > LIFE_MS - 600 ? Math.max(0, (LIFE_MS - age) / 600) : 1;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += GRAVITY * dt;
      p.vx -= p.vx * DRAG * dt;
      p.vy -= p.vy * DRAG * 0.35 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.y > H + 40) continue;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      if (p.label) {
        // A coin disc with the ticker across it, like the ones on the floor.
        ctx.rotate(((p.rot % 30) * Math.PI) / 180 * 0.2);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#0a0a0b';
        ctx.font = `600 ${p.label.length > 5 ? 8 : 10}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label.slice(0, 7), 0, 0.5);
      } else {
        ctx.rotate((p.rot * Math.PI) / 180);
        // Fake a tumbling ribbon by squashing on a second axis.
        ctx.scale(1, Math.abs(Math.cos((p.rot * Math.PI) / 90)) * 0.8 + 0.2);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };

  const onResize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  window.addEventListener('resize', onResize);

  function stop() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    canvas.remove();
  }

  raf = requestAnimationFrame(frame);
  return stop;
}
