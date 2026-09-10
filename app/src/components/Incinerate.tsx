import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { BURN_IS_LIVE } from '../lib/addresses';
import { Cremation } from './Cremation';
import { useIncinerate } from '../hooks/useIncinerate';
import { formatEthTrim } from '../lib/format';
import type { ScannedToken } from '../lib/scan';

/**
 * Destroying the dead tokens that have no buyer at any price.
 *
 * Deliberately its own flow, its own button and its own transaction --
 * see the header of `useIncinerate.ts` and of `BurnAdapter.sol`. This
 * component owns the confirm; the hook owns the chain.
 *
 * TWO THINGS THIS SCREEN MUST NEVER SOFTEN:
 *
 * 1. **It costs money and returns nothing.** Every token burned is one
 *    Permit2 approval the user pays for, plus a share of one sweep
 *    transaction, in exchange for zero proceeds. On a big pile that is
 *    real money. The estimate is shown before the first click and again
 *    inside the confirm, because a tool whose whole pitch is telling
 *    people when selling is not worth it cannot then quietly let them
 *    spend more than that burning.
 * 2. **It cannot be undone.** Two clicks, differently worded, and the
 *    second one says burn.
 *
 * WHY `willNotMove` IS EXCLUDED. The no-route pile holds two different
 * problems. `noQuote` means nobody will buy it -- burnable. `willNotMove`
 * is the BOW class: the token reverts on any transfer except to its own
 * pool, so `user -> Sweeper -> 0xdEaD` reverts exactly the way a sale
 * does. Those cannot be burned by us or by anyone, including their
 * holder, and offering it would be selling a button that always fails.
 */
export function Incinerate({
  tokens,
  gasCostPerLegWei,
  variant = 'inline',
}: {
  tokens: ScannedToken[];
  gasCostPerLegWei: bigint;
  /**
   * `primary` is the 52px button in the card footer, standing where
   * `Sweep N tokens` stands when the selection can actually be sold.
   *
   * It exists because an 11px underlined link is not a peer of a filled
   * 52px button, so on the one pile where burning IS the only available
   * action, the prominent control was the wrong one -- and ticking dead
   * tokens into the sell set and pressing it reverts the whole sweep
   * `NothingFilled()` and charges gas for the privilege.
   *
   * In this variant the checkbox IS the selection, so the confirm lists
   * what is going in but does not let you edit it there. Two selection
   * mechanisms on one irreversible action is worse than one.
   */
  variant?: 'inline' | 'primary';
}) {
  const { isConnected } = useAccount();
  const isPrimary = variant === 'primary';
  const { state, preflight, runApprovals, stop, signAndBurn, reset } = useIncinerate();
  const [confirming, setConfirming] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // Only `noQuote` can actually move. See the header.
  const burnable = useMemo(
    () => tokens.filter((t) => t.noRouteReason === 'noQuote'),
    [tokens],
  );
  const stuck = tokens.length - burnable.length;
  const chosen = useMemo(
    () => burnable.filter((t) => !excluded.has(t.address)),
    [burnable, excluded],
  );

  if (!BURN_IS_LIVE || !isConnected || burnable.length === 0) return null;

  const { stage } = state;
  const busy =
    stage === 'preflight' || stage === 'approving' || stage === 'signing' || stage === 'burning';

  // One approval per token plus the burn transaction itself.
  const estimate = gasCostPerLegWei * BigInt(chosen.length + 1);

  if (stage === 'done' && state.receipt) {
    const r = state.receipt;
    const n = r.legsFilled;
    // The overlay, and the same guard Celebration.tsx carries for sells:
    // a burn where nothing actually moved is not a moment. Zero legs
    // filled gets the plain box below, no overlay and no burst.
    if (n > 0) {
      const didNotMove = new Set(r.failed.map((f) => f.token.toLowerCase()));
      const burnedSymbols = state.items
        .filter((i) => !didNotMove.has(i.token.address.toLowerCase()))
        .map((i) => i.token.symbol);
      return <Cremation receipt={r} symbols={burnedSymbols} onClose={reset} />;
    }
    return (
      <div className="mt-2 rounded-lg border border-teal bg-raise p-3">
        <p className="text-[12px] leading-relaxed text-cream">
          Nothing was destroyed. Every token refused to move, so they are all
          still yours. You paid gas for the attempt.
        </p>
        {r.stranded.length > 0 && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            {r.stranded.length} could not be handed back, so{' '}
            {r.stranded.length === 1 ? 'it is' : 'they are'} stuck in the contract.
          </p>
        )}
        <button type="button" onClick={reset} className="mt-2 text-[11px] text-faint underline">
          Close
        </button>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="mt-2 rounded-lg border border-tan bg-raise p-3">
        <p className="text-[12px] leading-relaxed text-cream">{state.error}</p>
        <button type="button" onClick={reset} className="mt-2 text-[11px] text-faint underline">
          Start over
        </button>
      </div>
    );
  }

  // Approvals outstanding, or paused part way through them.
  if (stage === 'ready' || stage === 'approving' || stage === 'paused') {
    const left = state.steps.length - state.stepsDone;
    if (left > 0) {
      return (
        <div className="panel-furnace mt-3">
          <span className="panel-furnace-heat" aria-hidden="true" />
          <p className="panel-furnace-title">
            {state.stepsDone} of {state.steps.length} approvals done
          </p>
          {/* A row of bars, one per token, so the queue has a length you
              can see. The count of wallet prompts is the most surprising
              thing about this product; a progress bar is cheaper to read
              than a sentence about it. */}
          <div className="approve-track" aria-hidden="true">
            {state.steps.map((step, i) => (
              <span
                key={step.token}
                className={`approve-pip${i < state.stepsDone ? ' is-done' : ''}${
                  i === state.stepsDone && stage === 'approving' ? ' is-active' : ''
                }`}
              />
            ))}
          </div>
          <p className="panel-furnace-body">
            {left} {left === 1 ? 'confirmation' : 'confirmations'} left, one per token.
            Nothing is destroyed until you sign at the end.
          </p>
          <button
            type="button"
            onClick={runApprovals}
            disabled={stage === 'approving'}
            className="btn-furnace btn-furnace-sm mt-3"
          >
            <span className="btn-furnace-glow" aria-hidden="true" />
            <span className="btn-furnace-label">
              {stage === 'approving' ? 'Approving…' : 'Continue'}
            </span>
          </button>
          {stage === 'approving' ? (
            <button type="button" onClick={stop} className="link-quiet">
              Stop
            </button>
          ) : (
            <button type="button" onClick={reset} className="link-quiet">
              Cancel
            </button>
          )}
        </div>
      );
    }
    // Everything approved. This is the last click.
    // The last click. It gets the loudest panel in the flow, because it
    // is the only one after which nothing can be walked back.
    return (
      <div className="panel-furnace is-armed mt-3">
        <span className="panel-furnace-heat" aria-hidden="true" />
        <p className="panel-furnace-title">Ready to burn</p>
        <p className="panel-furnace-body">
          Every approval is in. Signing next destroys {state.items.length}{' '}
          {state.items.length === 1 ? 'token' : 'tokens'} permanently. There is no step
          after this one.
        </p>
        <button
          type="button"
          onClick={signAndBurn}
          className="btn-furnace btn-furnace-sm is-armed mt-3"
        >
          <span className="btn-furnace-glow" aria-hidden="true" />
          <span className="btn-furnace-label">
            Burn {state.items.length === 1 ? 'it' : 'them'}
          </span>
        </button>
        <button type="button" onClick={reset} className="link-quiet">
          Cancel
        </button>
      </div>
    );
  }

  if (busy) {
    return (
      <p className="mt-2 px-1 text-[11px] text-muted">
        {stage === 'preflight' && 'Checking balances and approvals…'}
        {stage === 'signing' && 'Waiting for your signature…'}
        {stage === 'burning' && 'Burning. Do not close this tab.'}
      </p>
    );
  }

  if (confirming) {
    return (
      <div className="panel-furnace is-armed mt-3">
        <span className="panel-furnace-heat" aria-hidden="true" />
        <p className="panel-furnace-title">
          Destroy {chosen.length} dead {chosen.length === 1 ? 'token' : 'tokens'}?
        </p>
        <p className="panel-furnace-body">
          They are not sold and nothing comes back. This costs about{' '}
          <span className="num text-tan">{formatEthTrim(estimate)} ETH</span> in gas, and
          once it is done it cannot be undone by anyone, including you.
        </p>

        {/* The manifest. Chips read as hot metal rather than as form
            controls, because in this variant the checkbox above IS the
            control and these are a last look at what goes in. */}
        <ul className="burn-manifest">
          {(isPrimary ? chosen : burnable).map((t) => {
            const out = excluded.has(t.address);
            return (
              <li key={t.address}>
                <button
                  type="button"
                  disabled={isPrimary}
                  onClick={() =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (out) next.delete(t.address);
                      else next.add(t.address);
                      return next;
                    })
                  }
                  title={isPrimary ? t.symbol : out ? 'Keep this one' : 'Click to keep this one'}
                  className={`burn-chip${out ? ' is-out' : ''}`}
                >
                  {t.symbol}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="panel-furnace-foot">
          {isPrimary ? 'Untick a token above to keep it out.' : 'Click a ticker to keep it.'}
        </p>

        <button
          type="button"
          disabled={chosen.length === 0}
          onClick={() => {
            setConfirming(false);
            void preflight(chosen);
          }}
          className="btn-furnace btn-furnace-sm is-armed mt-3"
        >
          <span className="btn-furnace-glow" aria-hidden="true" />
          <span className="btn-furnace-label">
            Yes, burn {chosen.length} {chosen.length === 1 ? 'token' : 'tokens'}
          </span>
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="link-quiet">
          Never mind
        </button>
      </div>
    );
  }

  if (isPrimary) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="btn-furnace mt-3">
        <span className="btn-furnace-glow" aria-hidden="true" />
        <span className="btn-furnace-label">
          Incinerate {burnable.length} dead {burnable.length === 1 ? 'token' : 'tokens'}
        </span>
      </button>
    );
  }

  return (
    <div className="mb-1.5 flex items-baseline gap-2 px-2">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[11px] font-semibold text-tan underline decoration-tan/40 underline-offset-2 hover:decoration-tan"
      >
        Incinerate {burnable.length}
      </button>
      {stuck > 0 && (
        <span className="text-[10px] text-faint">{stuck} cannot move at all</span>
      )}
    </div>
  );
}
