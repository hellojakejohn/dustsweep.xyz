import { useEffect, useMemo, useRef, useState } from 'react';
import type { SweepLeg } from '../lib/requote';
import type { ScannedToken } from '../lib/scan';
import { startBurst } from '../lib/burst';
import { shortAddress } from '../lib/format';
import { createShareCardPainter, type ShareCardPainter } from '../lib/sharecard';
import type { SweepReceipt } from '../lib/sweeper';
import { COLORS } from './JanitorStage';
import { shareText } from './Receipt';

/**
 * The money moment. Mounted next to the Receipt once a sweep has landed,
 * keyed on the receipt hash so it fires once per sweep and never again
 * on a re-render.
 *
 *   0ms    overlay in, focus on Close
 *   120ms  the burst (lib/burst.ts)
 *   250ms  the share card fades in, the ETH figure counts up from zero
 *          over ~700ms and settles on the exact receipt number
 *
 * Under prefers-reduced-motion there is no burst and no count-up. The
 * overlay still appears, the card still renders, the buttons still work.
 *
 * DO NOT REMOVE THE legsFilled GUARD BELOW. A sweep where nothing sold
 * is not a celebration. Confetti over a receipt that says "0 of 3 sold,
 * 3 came back" is the single fastest way to lose the one thing this
 * project has, which is that the number on screen is the truth. Zero
 * legs filled goes straight to the receipt with no overlay and no burst.
 */
export function Celebration({
  receipt,
  legs,
  tokens,
}: {
  receipt: SweepReceipt;
  /** The legs that went into the sweep, for the symbols that sold. */
  legs: SweepLeg[];
  /** Every scanned row, so a leg's address can be given a symbol. */
  tokens: ScannedToken[];
}) {
  // The guard. See the doc comment. Nothing renders, nothing fires.
  if (receipt.legsFilled === 0) return null;
  return <Overlay receipt={receipt} legs={legs} tokens={tokens} />;
}

const BURST_AT_MS = 120;
const CARD_AT_MS = 250;
const COUNT_MS = 700;

function Overlay({
  receipt,
  legs,
  tokens,
}: {
  receipt: SweepReceipt;
  legs: SweepLeg[];
  tokens: ScannedToken[];
}) {
  const [open, setOpen] = useState(true);
  const [cardIn, setCardIn] = useState(false);
  const [note, setNote] = useState<string>('');
  const [canShareFiles, setCanShareFiles] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cardHostRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef<ShareCardPainter | null>(null);
  const reduced = useReducedMotion();

  /**
   * Symbols of the tokens that actually sold: the legs we sent, minus
   * the ones the receipt says failed. Both lists are real; nothing here
   * is invented.
   */
  const symbols = useMemo(() => {
    const failed = new Set(receipt.failed.map((f) => f.token.toLowerCase()));
    return legs
      .filter((l) => !failed.has(l.token.address.toLowerCase()))
      .map(
        (l) =>
          l.token.symbol ||
          tokens.find((t) => t.address.toLowerCase() === l.token.address.toLowerCase())?.symbol ||
          shortAddress(l.token.address),
      );
  }, [receipt, legs, tokens]);

  // Focus, escape, and the scroll lock.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // The sequence. Every timer and the burst are torn down on close.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stopBurst: (() => void) | null = null;
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    if (!reduced) {
      timers.push(setTimeout(() => {
        if (!cancelled) stopBurst = startBurst(symbols, COLORS);
      }, BURST_AT_MS));
    }

    void createShareCardPainter(receipt, symbols).then((p) => {
      if (cancelled) return;
      painterRef.current = p;
      const host = cardHostRef.current;
      if (host) {
        host.replaceChildren(p.canvas);
      }
      const show = () => {
        if (cancelled) return;
        setCardIn(true);
        if (reduced) {
          p.paint(receipt.userOutWei);
          return;
        }
        // Count up from zero, ease-out, settle on the exact figure.
        const t0 = performance.now();
        const target = receipt.userOutWei;
        const tick = (now: number) => {
          if (cancelled) return;
          const u = Math.min(1, (now - t0) / COUNT_MS);
          const e = 1 - Math.pow(1 - u, 3);
          // bigint math on a 1e6 grid so the intermediate frames are
          // real fractions of the target, not float noise.
          const v = u >= 1 ? target : (target * BigInt(Math.round(e * 1e6))) / 1_000_000n;
          p.paint(v);
          if (u < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      };
      const wait = Math.max(0, CARD_AT_MS - (performance.now() - mountedAt));
      timers.push(setTimeout(show, wait));
    });
    const mountedAt = performance.now();

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      cancelAnimationFrame(raf);
      stopBurst?.();
    };
  }, [open, receipt, symbols, reduced]);

  // Web Share with files: one tap to a post with the image attached.
  useEffect(() => {
    try {
      const probe = new File([new Uint8Array(1)], 'x.png', { type: 'image/png' });
      setCanShareFiles(
        typeof navigator.share === 'function' &&
          typeof navigator.canShare === 'function' &&
          navigator.canShare({ files: [probe] }),
      );
    } catch {
      setCanShareFiles(false);
    }
  }, []);

  if (!open) return null;

  const fileName = `dustsweep-${receipt.hash.slice(2, 10)}.png`;

  const toBlob = async (): Promise<Blob> => {
    const p = painterRef.current;
    if (!p) throw new Error('card not ready');
    // Make sure the exported frame is the settled figure, never a
    // count-up frame.
    p.paint(receipt.userOutWei);
    return new Promise((res, rej) =>
      p.canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
    );
  };

  const save = async () => {
    try {
      const blob = await toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setNote('Saved.');
    } catch {
      setNote('Could not save the image.');
    }
  };

  /** Promise form of the ClipboardItem value, which is what Safari needs. */
  const copyImage = async (): Promise<boolean> => {
    try {
      if (typeof ClipboardItem === 'undefined') return false;
      const item = new ClipboardItem({ 'image/png': toBlob() });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      return false;
    }
  };

  const copy = async () => {
    if (await copyImage()) {
      setNote('Image copied.');
    } else {
      // Silent fallback to Save.
      await save();
    }
  };

  const post = async () => {
    const copied = await copyImage();
    setNote(copied ? 'The image is on your clipboard. Paste it into the post.' : 'Could not copy the image. Save it and attach it.');
    window.open(
      `https://x.com/intent/post?text=${encodeURIComponent(shareText(receipt))}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  const share = async () => {
    try {
      const blob = await toBlob();
      const file = new File([blob], fileName, { type: 'image/png' });
      await navigator.share({ files: [file], text: shareText(receipt) });
    } catch (err) {
      // AbortError is the user closing the sheet. Anything else, offer
      // the file instead.
      if ((err as { name?: string })?.name !== 'AbortError') await save();
    }
  };

  const btn =
    'h-11 rounded-lg border border-teal px-3 text-[13px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-orange';

  return (
    <div
      className="celebrate fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sweep complete"
        className="celebrate-card relative z-50 w-full max-w-[560px] rounded-xl border border-teal bg-card p-4 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          ref={cardHostRef}
          className={`overflow-hidden rounded-lg border border-teal bg-page transition-opacity duration-500 ${
            cardIn ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ aspectRatio: '1200 / 675' }}
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {canShareFiles ? (
            <button
              type="button"
              onClick={() => void share()}
              className="h-11 flex-1 rounded-lg bg-orange px-4 text-[13px] font-semibold text-page transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cream"
            >
              Share
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void post()}
                className="h-11 flex-1 rounded-lg bg-orange px-4 text-[13px] font-semibold text-page transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cream"
              >
                Post on X
              </button>
              <button type="button" onClick={() => void copy()} className={btn}>
                Copy image
              </button>
              <button type="button" onClick={() => void save()} className={btn}>
                Save image
              </button>
            </>
          )}
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} className={btn}>
            Close
          </button>
        </div>
        <p className="mt-2 min-h-[16px] text-[11px] leading-relaxed text-faint" aria-live="polite">
          {note ||
            (canShareFiles
              ? 'Shares the image and the text together.'
              : 'Post on X copies the image to your clipboard first. Paste it into the post.')}
        </p>
      </div>
    </div>
  );
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
