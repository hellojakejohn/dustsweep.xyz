import { useState } from 'react';
import { CapabilityProbe } from './components/CapabilityProbe';
import { ConnectButton } from './components/Connect';
import { JanitorStage } from './components/JanitorStage';
import { SweepCA } from './components/SweepCA';
import { SweepCard } from './components/SweepCard';
import { EXPLORER, SWEEP_TOKEN } from './lib/addresses';
import { robinhoodChain } from './lib/chain';
import { FIXTURE_IS_ON } from './lib/fixture';
import { RPC_IS_OVERRIDDEN } from './lib/rpc';

/** Verified public on 4 Sep 2026. Keep this a real link or plain text --
 *  never a dead one, on a line whose whole job is being trustworthy. */
const REPO_URL = 'https://github.com/hellojakejohn/dustsweep.xyz';

/** TEMPORARY. dustsweep.xyz/?caps only. Unlinked, so normal visitors
 *  never see it. Delete this and CapabilityProbe.tsx once the batching
 *  question is answered. */
const SHOW_CAPS =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('caps');

export function App() {
  const [status, setStatus] = useState('');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="site-header mx-auto flex w-full max-w-[560px] items-center justify-between gap-2 py-3 sm:gap-3">
        {/* Below 400px the wordmark is the thing that yields: the mark
            shrinks and `.xyz` goes (see .wordmark-tld in index.css).
            The CA chip never loses anything and the connect button is
            the connect button. Header room on a phone is the wordmark's
            problem, not the address's. */}
        <a href="/" className="flex min-w-0 shrink items-center gap-1 sm:gap-2.5">
          <img
            src="/janitor-mark.png"
            alt=""
            width={44}
            height={44}
            className="header-mark w-auto shrink-0"
          />
          <span className="wordmark truncate font-semibold tracking-tight text-cream">
            dustsweep<span className="wordmark-tld text-faint">.xyz</span>
          </span>
        </a>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          {/* The official SWEEP CA, as a chip. Renders in every state and
              at every breakpoint; it is an anti-impersonation control
              before it is a convenience. Moved here from under the
              disclosure on 8 Sep so the janitor is back above the fold. */}
          <SweepCA />
          {/* The chain by mark. Jake's call, 6 Sep, reversing the day-7
              text-only decision. The file is Robinhood's own asset from
              their brand page, dropped in as public/robinhood-mark.png;
              nothing here draws it. Name stays in alt/title for screen
              readers and hover. Not wired to the CA on purpose. */}
          <span
            className="hidden h-8 items-center rounded-lg border border-teal px-1.5 sm:inline-flex"
            title={robinhoodChain.name}
          >
            <img src="/robinhood-mark.png" alt={robinhoodChain.name} className="h-5 w-5 rounded-[4px]" />
          </span>
          {/* Never hidden at any breakpoint, and never quiet. Demoing a
              fork that looks exactly like mainnet has burned people. */}
          {(RPC_IS_OVERRIDDEN || FIXTURE_IS_ON) && (
            <span className="inline-flex h-8 shrink-0 items-center rounded-lg border border-tan px-2.5 text-[11px] font-semibold text-tan">
              {FIXTURE_IS_ON ? 'fork fixture' : 'local fork'}
            </span>
          )}
          <div className="header-connect shrink-0">
            <ConnectButton />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-col px-4 pt-2 sm:pt-3">
        <SweepCard onStatus={setStatus} />

        {status && (
          <p className="mt-3 px-1 text-center text-[11.5px] leading-relaxed text-muted">{status}</p>
        )}
        {/* Renders in EVERY state, on purpose. This is the line a stranger
            reads while deciding whether to connect a wallet at all, so it
            cannot live inside the card -- the card's own copy only appears
            once a scan has finished. CLAUDE.md has this on the never-cut
            list. Do not soften "Unaudited", and do not hide it behind a
            tooltip or a details element. The full fee and money story
            lives on /docs.html; the one number that matters stays here.

            The last sentence is the CA chip's caption, folded in here on
            8 Sep when the chip moved to the header. "Anything else
            claiming to be SWEEP is not ours" is the whole point of the
            element and stays word for word. */}
        <p className="mt-3 px-1 text-center text-[11.5px] leading-relaxed text-muted">
          Non-custodial. Unaudited.{' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-cream underline decoration-muted underline-offset-2 transition-colors hover:decoration-cream"
          >
            Source is public
          </a>
          . We keep 5% of what your dust sells for, capped in the contract. The gas is on you.{' '}
          <a
            href="/docs.html"
            className="text-cream underline decoration-muted underline-offset-2 transition-colors hover:decoration-cream"
          >
            Where the money goes
          </a>
          . The official SWEEP contract on Robinhood Chain is the address in the header,{' '}
          <a
            href={`${EXPLORER}/token/${SWEEP_TOKEN}`}
            target="_blank"
            rel="noreferrer"
            className="text-cream underline decoration-muted underline-offset-2 transition-colors hover:decoration-cream"
          >
            here on Blockscout
          </a>
          . Anything else claiming to be SWEEP is not ours.
        </p>

        {SHOW_CAPS && <CapabilityProbe />}
      </main>

      {/* Sits at the bottom of the viewport when the page is short and
          below the copy when it is long. Never over the disclosure text. */}
      <JanitorStage />
    </div>
  );
}
