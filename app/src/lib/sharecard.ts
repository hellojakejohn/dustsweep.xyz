import { SWEEP_TOKEN } from './addresses';
import { formatEthTrim } from './format';
import type { SweepReceipt } from './sweeper';

/**
 * The share card, as pixels. 1200x675 CSS px (X's large-card ratio)
 * drawn at 2x, system fonts only so there is no webfont to wait on.
 *
 * Every figure on it comes from the receipt or from addresses.ts. The
 * ETH number is `formatEthTrim(receipt.userOutWei)`, the same call the
 * on-screen receipt makes, so the two can never disagree. The honest
 * line counts returned legs and stranded legs separately, the way the
 * receipt and `shareText` do; a card that only reports the good half is
 * an advert.
 *
 * No percentages, no fee claims, nothing about Pons, splits, buybacks or
 * the dev buy. The full checksummed CA goes on the card on purpose: the
 * card is the thing that travels, and a fake SWEEP costs somebody about
 * a minute to deploy.
 *
 * Palette and font stacks mirror index.css by hand. Canvas cannot read
 * CSS custom properties from a stylesheet it is not attached to, so if
 * the palette moves, this file moves with it.
 */

export const CARD_W = 1200;
export const CARD_H = 675;
const SCALE = 2;

const PAGE = '#0a0a0b';
const CREAM = '#f0e4cc';
const MUTED = '#a39b8b';
const FAINT = '#8e8778';
const TAN = '#d8b377';
const TEAL = '#304854';

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace";

const FLOOR_Y = 596;
const LEFT = 64;
/** Text column stops here so it never runs under the janitor. */
const TEXT_MAX_W = 700;
const MAX_CHIPS = 6;
const SYMBOL_MAX = 10;

export type ShareCardPainter = {
  canvas: HTMLCanvasElement;
  /**
   * Draw the whole card with `displayWei` in the big number. The
   * celebration uses this for the count-up; `renderShareCard` calls it
   * once with the real figure and that is the only frame that leaves
   * the page.
   */
  paint: (displayWei: bigint) => void;
};

/** One call, one finished card. What the buttons save, copy and share. */
export async function renderShareCard(
  receipt: SweepReceipt,
  symbols: string[],
): Promise<HTMLCanvasElement> {
  const p = await createShareCardPainter(receipt, symbols);
  p.paint(receipt.userOutWei);
  return p.canvas;
}

export async function createShareCardPainter(
  receipt: SweepReceipt,
  symbols: string[],
): Promise<ShareCardPainter> {
  const [janitor, mark] = await Promise.all([
    loadImage('/janitor-solo.png'),
    loadImage('/janitor-mark.png'),
  ]);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${CARD_W} / ${CARD_H}`;
  const ctx = canvas.getContext('2d')!;

  const paint = (displayWei: bigint) => {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.textBaseline = 'alphabetic';

    /* ground + floor */
    ctx.fillStyle = PAGE;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.fillStyle = rgba(CREAM, 0.15);
    ctx.fillRect(0, FLOOR_Y, CARD_W, 1);

    /* top left: mark + wordmark */
    let x = LEFT;
    if (mark) {
      const h = 56;
      const w = (mark.naturalWidth / mark.naturalHeight) * h;
      ctx.drawImage(mark, x, 44, w, h);
      x += w + 16;
    }
    ctx.fillStyle = CREAM;
    ctx.font = `600 30px ${SANS}`;
    ctx.fillText('dustsweep.xyz', x, 82);

    /* janitor, right, feet on the floor, about half the card tall */
    if (janitor) {
      const h = Math.round(CARD_H * 0.52);
      const w = (janitor.naturalWidth / janitor.naturalHeight) * h;
      ctx.drawImage(janitor, CARD_W - 72 - w, FLOOR_Y - h + 6, w, h);
    }

    /* label */
    ctx.fillStyle = FAINT;
    ctx.font = `500 19px ${SANS}`;
    tracked(ctx, 'LANDED IN YOUR WALLET', LEFT, 190, 0.14);

    /* the number */
    ctx.fillStyle = TAN;
    ctx.font = `600 96px ${MONO}`;
    ctx.fillText(`${formatEthTrim(displayWei)} ETH`, LEFT - 4, 292);

    /* headline */
    const n = receipt.legsFilled;
    ctx.fillStyle = CREAM;
    ctx.font = `600 38px ${SANS}`;
    ctx.fillText(`Swept ${n} dead ${n === 1 ? 'token' : 'tokens'} off Robinhood Chain`, LEFT, 364);

    /* symbol chips */
    let y = 396;
    y = chips(ctx, symbols, LEFT, y);

    /* the honest line */
    ctx.fillStyle = MUTED;
    ctx.font = `400 22px ${SANS}`;
    wrap(ctx, honestLine(receipt), LEFT, y + 34, TEXT_MAX_W, 30);

    /* bottom bar */
    const by = 646;
    ctx.fillStyle = CREAM;
    ctx.font = `600 16px ${SANS}`;
    tracked(ctx, 'SWEEP', LEFT, by, 0.1);
    ctx.fillStyle = TAN;
    ctx.font = `400 18px ${MONO}`;
    ctx.fillText(SWEEP_TOKEN, LEFT + 84, by);
    ctx.fillStyle = FAINT;
    ctx.font = `400 17px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText('Unaudited. Non-custodial. Source is public.', CARD_W - LEFT, by);
    ctx.textAlign = 'left';
  };

  return { canvas, paint };
}

/**
 * Returned and stranded legs, counted separately. Same facts as the
 * receipt's sentence and `shareText`; never merged into one reassuring
 * line.
 */
function honestLine(r: SweepReceipt): string {
  const returned = r.failed.filter((f) => f.returned).length;
  const stranded = r.stranded.length;
  const parts: string[] = [];
  parts.push(
    returned + stranded === 0
      ? `All ${r.legsFilled} of ${r.legsAttempted} sold.`
      : `${r.legsFilled} of ${r.legsAttempted} sold.`,
  );
  if (returned > 0) {
    parts.push(
      `${returned === 1 ? 'One token' : `${returned} tokens`} found no buyer and went back to the wallet.`,
    );
  }
  if (stranded > 0) {
    parts.push(`${stranded === 1 ? 'One' : String(stranded)} could not be sent back at all.`);
  }
  if (returned + stranded === 0) parts.push('One signature covered the lot.');
  return parts.join(' ');
}

function chips(ctx: CanvasRenderingContext2D, symbols: string[], x0: number, y: number): number {
  const shown = symbols
    .filter((s) => s && s !== '?')
    .slice(0, MAX_CHIPS)
    .map((s) => (s.length > SYMBOL_MAX ? `${s.slice(0, SYMBOL_MAX)}…` : s));
  const extra = Math.max(0, symbols.filter((s) => s && s !== '?').length - shown.length);
  if (shown.length === 0 && extra === 0) return y;

  ctx.font = `500 19px ${MONO}`;
  const padX = 14;
  const h = 38;
  const gap = 10;
  let x = x0;
  let rowY = y;
  const draw = (label: string, outlined: boolean) => {
    const w = Math.ceil(ctx.measureText(label).width) + padX * 2;
    if (x + w > x0 + TEXT_MAX_W) {
      x = x0;
      rowY += h + gap;
    }
    if (outlined) {
      ctx.strokeStyle = TEAL;
      ctx.lineWidth = 2;
      roundRect(ctx, x + 1, rowY + 1, w - 2, h - 2, 19);
      ctx.stroke();
      ctx.fillStyle = CREAM;
    } else {
      ctx.fillStyle = FAINT;
    }
    ctx.fillText(label, x + padX, rowY + 26);
    x += w + gap;
  };
  for (const s of shown) draw(s, true);
  if (extra > 0) draw(`+${extra} more`, false);
  return rowY + h;
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lineH;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

/** Uppercase label with letter-spacing, by hand, since `ctx.letterSpacing`
 *  is not everywhere yet. */
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, em: number) {
  // ctx.font reads back as "500 19px ui-sans-serif, ..."; the size is
  // the px token, not the first number.
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '16');
  const gap = size * em;
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + gap;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Resolves to null rather than rejecting: a missing image drops the
 *  picture, never the card. */
async function loadImage(src: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } catch {
    return null;
  }
}
