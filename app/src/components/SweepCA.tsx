import { useEffect, useRef, useState } from 'react';
import { EXPLORER, SWEEP_TOKEN } from '../lib/addresses';

/** `0x73F6…aed8`. Head is long enough to eyeball against a post on X,
 *  tail is what people actually check. Both halves matter -- an
 *  impersonator picks a vanity address that matches one end. */
const SHORT = `${SWEEP_TOKEN.slice(0, 6)}…${SWEEP_TOKEN.slice(-4)}`;

/**
 * Clipboard, with the old path kept. dustsweep.xyz is HTTPS so
 * `navigator.clipboard` is there, but this is the one element on the
 * site a stranger taps on a phone they have never used before, and a
 * silent no-op here means they paste the wrong CA from somewhere else.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* falls through to the 2014 way */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type State = 'idle' | 'copied' | 'failed';

/**
 * The official contract address, on the page, in every state.
 *
 * This is an anti-impersonation element before it is a convenience.
 * ~63,000 dead tokens on this chain means a fake SWEEP costs somebody
 * about a minute to deploy, and the only thing that beats it is a
 * canonical address a visitor can see without clicking anything. So:
 * never behind a tooltip, never behind a details element, never hidden
 * at a breakpoint, and never rendered from anything but SWEEP_TOKEN.
 *
 * Deliberately NOT wired to the Robinhood mark in the header. That mark
 * is a chain indicator and it is Robinhood's own asset; making it copy
 * our token's address implies an endorsement we do not have, and it is
 * hidden below sm anyway, which is where the traffic is.
 */
export function SweepCA() {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = async () => {
    const ok = await copyText(SWEEP_TOKEN);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    // The failed state shows the full address for manual selection, so
    // it stays up long enough to actually select it.
    timer.current = setTimeout(() => setState('idle'), ok ? 1600 : 12000);
  };

  return (
    <div className="mt-4 px-1">
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label={`Copy the official SWEEP contract address, ${SWEEP_TOKEN}`}
        title={SWEEP_TOKEN}
        className="group flex w-full items-center gap-2.5 rounded-xl border border-teal bg-raise px-3 py-2.5 text-left transition-colors hover:border-tan focus:outline-none focus-visible:ring-2 focus-visible:ring-orange"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cream">
          Sweep
        </span>
        <span
          className={`num min-w-0 flex-1 text-[12.5px] text-tan ${
            state === 'failed' ? 'break-all' : 'truncate'
          }`}
        >
          {state === 'failed' ? SWEEP_TOKEN : SHORT}
        </span>
        <span
          className={`shrink-0 text-[11px] font-semibold ${
            state === 'copied' ? 'text-orange' : 'text-muted group-hover:text-cream'
          }`}
        >
          {state === 'copied' ? (
            <span className="inline-flex items-center gap-1">
              <CheckIcon />
              Copied
            </span>
          ) : state === 'failed' ? (
            'Select it'
          ) : (
            <span className="inline-flex items-center gap-1">
              <CopyIcon />
              Copy
            </span>
          )}
        </span>
      </button>

      {/* Screen readers get the result; sighted users get the label swap. */}
      <span aria-live="polite" className="sr-only">
        {state === 'copied'
          ? 'Contract address copied'
          : state === 'failed'
            ? 'Copy failed. The full address is shown for you to select.'
            : ''}
      </span>

      <p className="mt-1.5 text-center text-[11px] leading-relaxed text-faint">
        Official SWEEP contract on Robinhood Chain.{' '}
        <a
          href={`${EXPLORER}/token/${SWEEP_TOKEN}`}
          target="_blank"
          rel="noreferrer"
          className="text-muted underline decoration-faint underline-offset-2 transition-colors hover:text-cream hover:decoration-cream"
        >
          View on Blockscout
        </a>
        . Anything else claiming to be SWEEP is not ours.
      </p>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10.5 3.2A2 2 0 0 0 8.8 1.5H3.5a2 2 0 0 0-2 2v5.3a2 2 0 0 0 1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 8.5l3.6 3.6L13.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
