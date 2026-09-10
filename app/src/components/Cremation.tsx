import { useEffect, useRef, useState } from 'react';
import { EXPLORER } from '../lib/addresses';
import { setBurnOverlay } from '../lib/burn';
import { startEmbers } from '../lib/embers';
import type { SweepReceipt } from '../lib/sweeper';

/**
 * The moment a burn lands.
 *
 * This exists because the burn used to end in a 12px grey paragraph
 * while the sell flow got confetti, an overlay and a share card. The
 * asymmetry was backwards: selling dust returns money, which is its own
 * reward, whereas burning is the one thing on this site a person pays
 * for and receives literally nothing back from. If any screen here earns
 * a moment it is this one.
 *
 * IT IS NOT THE SELL CELEBRATION AND MUST NOT BECOME IT. `Celebration`
 * counts up `receipt.userOutWei` and paints a share card built around an
 * ETH figure. For a burn that figure is zero, always, by construction --
 * BurnAdapter reverts on a non-zero minOut. Running it here would count
 * up to 0.00 ETH under confetti, which is both absurd and the exact kind
 * of dressed-up nothing this project is supposed to be the opposite of.
 *
 * So the copy states the trade plainly and does not soften it: you paid
 * gas, you got nothing, the tokens are gone and cannot come back. The
 * only claim on screen is a count that came off the chain, and the tx
 * link is right there so anyone can check it.
 *
 * The burst is `lib/embers.ts`, not the sell path's confetti. The first
 * version of this screen reused `startBurst` with an orange palette and
 * it read as a party with the lights changed: confetti blasts outward and
 * falls under gravity, fire rises and cools and goes out at the top. Same
 * colours, opposite motion, and motion is what the eye actually reads.
 * The ash particles carry the tickers that were really destroyed and char
 * from tan to soot as they climb.
 */

const BURST_AT_MS = 140;
/**
 * The card waits. For the first beat the screen is just the darkened page,
 * the embers going up, and the furnace roaring above the scrim -- which is
 * the whole thing the user paid for and, until this delay existed, was
 * covered by a receipt 0ms after it started. Read the moment, then read
 * the numbers.
 */
const CARD_AT_MS = 620;

export function Cremation({
  receipt,
  symbols,
  onClose,
}: {
  receipt: SweepReceipt;
  /** Tickers that actually went in, for the burst and the list. */
  symbols: string[];
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [cardIn, setCardIn] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const n = receipt.legsFilled;
  const failed = receipt.failed.length;
  const stranded = receipt.stranded.length;

  // Hold the furnace above the scrim for exactly as long as this is up.
  // Both leave in the same frame, so there is no moment where the fire
  // is dimmed under a card that is still open.
  useEffect(() => {
    setBurnOverlay(true);
    return () => setBurnOverlay(false);
  }, []);

  useEffect(() => {
    // Reduced motion gets the card immediately: the delay exists to let an
    // animation be seen, and there is no animation to see.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCardIn(true);
      return;
    }
    const t = setTimeout(() => setCardIn(true), CARD_AT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!cardIn) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, cardIn]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) stop = startEmbers(symbols);
    }, BURST_AT_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      stop?.();
    };
  }, [symbols]);

  const post = () => {
    window.open(
      `https://x.com/intent/post?text=${encodeURIComponent(burnShareText(receipt))}`,
      '_blank',
      'noopener,noreferrer',
    );
    setNote('Opened X.');
  };

  const btn =
    'h-11 rounded-lg border border-teal px-3 text-[13px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream focus:outline-none focus-visible:ring-2 focus-visible:ring-orange';

  return (
    <div
      className="celebrate fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Burn complete"
        hidden={!cardIn}
        className="celebrate-card relative z-50 w-full max-w-[420px] rounded-xl border border-teal bg-card p-5 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="num text-[44px] font-semibold leading-none text-orange">{n}</p>
        <p className="mt-2 text-[15px] font-semibold text-cream">
          dead {n === 1 ? 'token' : 'tokens'} incinerated
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          They are at the burn address now. Nothing came back and nothing can be
          recovered. That was the point.
        </p>

        {symbols.length > 0 && (
          <ul className="mt-3 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
            {symbols.map((s, i) => (
              <li
                key={`${s}-${i}`}
                className="num rounded border border-tan/40 px-1.5 py-0.5 text-[10px] text-faint line-through"
              >
                {s}
              </li>
            ))}
          </ul>
        )}

        {/* The half that is not good news. Same treatment the receipt and
            the share card give it: counted separately, never folded into
            the headline, never left off. */}
        {(failed > 0 || stranded > 0) && (
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            {failed > 0 && (
              <>
                {failed} refused to move and{' '}
                {stranded > 0
                  ? `${stranded} could not be handed back, so ${stranded === 1 ? 'it is' : 'they are'} stuck in the contract.`
                  : 'went back to your wallet.'}
              </>
            )}
            {failed === 0 && stranded > 0 && (
              <>
                {stranded} could not be handed back and{' '}
                {stranded === 1 ? 'is' : 'are'} stuck in the contract.
              </>
            )}
          </p>
        )}

        <a
          href={`${EXPLORER}/tx/${receipt.hash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-[11px] text-faint underline decoration-faint/50 underline-offset-2 hover:text-muted"
        >
          Check it on the explorer
        </a>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={post}
            className="h-11 flex-1 rounded-lg bg-orange px-4 text-[13px] font-semibold text-page transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-cream"
          >
            Post on X
          </button>
          <button ref={closeRef} type="button" onClick={onClose} className={btn}>
            Close
          </button>
        </div>
        <p className="mt-2 min-h-[16px] text-[11px] leading-relaxed text-faint" aria-live="polite">
          {note || 'The furnace on this page is reading the same transaction.'}
        </p>
      </div>
    </div>
  );
}

/** Deadpan, one real number, no promise. Same voice as the sell text. */
export function burnShareText(receipt: SweepReceipt): string {
  const n = receipt.legsFilled;
  return (
    `Incinerated ${n} dead ${n === 1 ? 'token' : 'tokens'}. ` +
    `No buyer at any price, so there was nothing to sell. ` +
    `Got nothing back, which is the honest outcome.\n\n` +
    `dustsweep.xyz`
  );
}
