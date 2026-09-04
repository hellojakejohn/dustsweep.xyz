import { useState } from 'react';
import { ConnectButton } from './components/Connect';
import { SweepCard } from './components/SweepCard';
import { robinhoodChain } from './lib/chain';

/** Verified public on 4 Sep 2026. Keep this a real link or plain text --
 *  never a dead one, on a line whose whole job is being trustworthy. */
const REPO_URL = 'https://github.com/hellojakejohn/dustsweep.xyz';

export function App() {
  const [status, setStatus] = useState('');

  return (
    <div className="min-h-dvh px-4 pb-16">
      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-3 py-4">
        <span className="flex items-center gap-2">
          <img
            src="/janitor-mark.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-auto shrink-0"
          />
          <span className="text-[14px] font-semibold tracking-tight text-cream">
            dustsweep<span className="text-faint">.xyz</span>
          </span>
        </span>
        <div className="flex items-center gap-2">
          <span className="num hidden h-8 items-center rounded-lg border border-teal px-2.5 text-[11px] text-muted sm:inline-flex">
            chain {robinhoodChain.id}
          </span>
          <ConnectButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-col pt-[8vh]">
        <SweepCard onStatus={setStatus} />

        <p className="mt-3.5 min-h-[16px] px-1 text-[11.5px] leading-relaxed text-muted">
          {status}
        </p>
        {/* Renders in EVERY state, on purpose. This is the line a stranger
            reads while deciding whether to connect a wallet at all, so it
            cannot live inside the card -- the card's own copy only appears
            once a scan has finished. CLAUDE.md has this on the never-cut
            list. Do not soften "Unaudited", and do not hide it behind a
            tooltip or a details element. */}
        <p className="mt-1 px-1 text-[11.5px] leading-relaxed text-muted">
          Non-custodial. Exact-amount approvals, per transaction.{' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-cream underline decoration-muted underline-offset-2 transition-colors hover:decoration-cream"
          >
            Source is public
          </a>
          . Unaudited.
        </p>

        <p className="mt-1 px-1 text-[11.5px] leading-relaxed text-faint">
          Two launchpads shipped ~63,000 tokens onto this chain, then turned off their front
          ends.
        </p>
      </main>
    </div>
  );
}
