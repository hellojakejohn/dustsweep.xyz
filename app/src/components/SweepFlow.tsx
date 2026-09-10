import { useMemo } from 'react';
import { BURN_IS_LIVE, SWEEPER_IS_OVERRIDDEN } from '../lib/addresses';
import { explorerTx } from '../lib/chain';
import { DELEGATED_NOTICE } from '../lib/delegation';
import { formatEth, formatEthTrim, shortAddress } from '../lib/format';
import { APPROVE_EXACT } from '../lib/permit2';
import { DROP_REASON_COPY, legTotals, type SweepLeg } from '../lib/requote';
import type { ScannedToken } from '../lib/scan';
import type { useSweep } from '../hooks/useSweep';
import { Celebration } from './Celebration';
import { Incinerate } from './Incinerate';
import { Receipt } from './Receipt';

/**
 * The write half's screen.
 *
 * There is no batching on 4663, so the shape is a queue: N approvals,
 * one signature, one sweep. Two rules run through everything below.
 *
 * One, the real cost is on screen BEFORE the button, not after it. The
 * count of wallet confirmations is the single most surprising thing
 * about this product and finding it out mid-flow is how people leave.
 *
 * Two, almost nobody sweeps twice. There is no second visit in which to
 * recover a bad first one, so every terminal state says plainly what the
 * user still has. Nobody should ever be unsure whether their tokens
 * moved.
 */
export function SweepFlow({
  sweep,
  feeBps,
  selected,
  allTokens,
  gasCostPerLegWei,
  onScanAgain,
}: {
  /**
   * Owned by SweepCard, not by this component. The card needs the stage
   * to lock the checkboxes while a sweep is in flight, and a batch whose
   * contents can change under it mid-run is the worst bug available here.
   */
  sweep: ReturnType<typeof useSweep>;
  /**
   * `feeBpsNative` as read on load for the preview. Once a sweep has
   * started, `config.feeBpsNative` from the preflight read takes over;
   * the two are the same storage slot and this is only the fallback.
   */
  feeBps: bigint | null;
  selected: ScannedToken[];
  /** Every scanned row, so a failed leg's address can be given a symbol. */
  allTokens: ScannedToken[];
  gasCostPerLegWei: bigint;
  onScanAgain: () => void;
}) {
  const { stage, config, steps, stepsDone } = sweep;

  /**
   * One leg over `maxLegValueWei` reverts the WHOLE batch and the user
   * pays gas for nothing, so it is caught here rather than on chain.
   * The ceiling is read from the deployment, never hardcoded.
   */
  const overCeiling = useMemo(() => {
    if (!config) return [];
    return selected.filter((t) => t.grossOutWei > config.maxLegValueWei);
  }, [selected, config]);

  if (stage === 'done' && sweep.receipt) {
    return (
      <>
        <Receipt
          receipt={sweep.receipt}
          feeBps={config?.feeBpsNative ?? feeBps ?? 0n}
          tokens={allTokens}
          onScanAgain={() => {
            sweep.reset();
            onScanAgain();
          }}
        />
        {/* Keyed on the hash: once per sweep, never again on a re-render.
            Renders nothing when legsFilled is 0; see Celebration.tsx. */}
        <Celebration
          key={sweep.receipt.hash}
          receipt={sweep.receipt}
          legs={sweep.legs}
          tokens={allTokens}
        />
      </>
    );
  }

  if (stage === 'drift') {
    return (
      <DriftConfirm
        rows={sweep.drifted}
        dropped={sweep.dropped}
        legs={sweep.legs}
        totals={legTotals(
          sweep.legs,
          gasCostPerLegWei,
          config?.feeBpsNative ?? feeBps ?? 0n,
        )}
        onConfirm={() => void sweep.confirmDrift()}
        onCancel={sweep.cancelDrift}
      />
    );
  }

  if (stage === 'error') {
    return (
      <Failure
        message={sweep.error}
        stage={sweep.failureStage}
        stoppedByUser={sweep.stoppedByUser}
        dropped={sweep.dropped}
        onRetry={sweep.failureStage === 'preflight' ? sweep.retry : () => void sweep.start()}
        canRetry={sweep.failureStage !== 'preflight' ? config !== null : true}
      />
    );
  }

  const busy =
    stage === 'approving' ||
    stage === 'requoting' ||
    stage === 'signing' ||
    stage === 'sweeping';

  /**
   * WHAT THE BIG BUTTON DOES WHEN NOTHING CAN BE SOLD.
   *
   * `noQuote` tokens are tickable (only `willNotMove` is locked out), so a
   * user can select nothing but dead tokens and press Sweep. Every leg
   * then fails, `filled == 0`, and `Sweeper.sol:145` reverts
   * `NothingFilled()` -- a transaction that was guaranteed from the start
   * to do nothing, charged at full gas. The Totals line above says
   * `You receive` in the negative and the button stays lit anyway.
   *
   * So when the selection is ENTIRELY dead, the primary action becomes
   * the furnace instead. Burning is the only thing that can be done with
   * those tokens, and it is now the control that looks like the main one.
   * A mixed selection keeps Sweep, because the sellable legs are real and
   * the dead ones fail individually and come home.
   */
  const deadSelected = selected.filter((t) => t.noRouteReason === 'noQuote');
  const burnOnly = selected.length > 0 && deadSelected.length === selected.length;
  const showBurnPrimary = burnOnly && BURN_IS_LIVE;

  return (
    <div className="mt-4">
      {stage === 'paused' && (
        <Paused done={stepsDone} total={steps.length} onStartOver={sweep.reset} />
      )}

      {overCeiling.length > 0 && config && (
        <Blocked tokens={overCeiling} ceilingWei={config.maxLegValueWei} />
      )}

      {busy ? (
        <InFlight
          stage={stage}
          steps={steps}
          stepsDone={stepsDone}
          legCount={sweep.legs.length || selected.length}
          hash={sweep.currentHash}
          onStop={sweep.stop}
        />
      ) : (
        <>
          {sweep.delegated && <Delegated />}
          {showBurnPrimary ? (
            <>
              <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-muted">
                Nothing you have selected can be sold. Nobody is buying them at any
                price, so the only thing left is to destroy them.
              </p>
              <Incinerate
                variant="primary"
                tokens={selected}
                gasCostPerLegWei={gasCostPerLegWei}
              />
            </>
          ) : (
            <>
          {deadSelected.length > 0 && (
            <p className="mt-3 px-1 text-[11.5px] leading-relaxed text-tan">
              {deadSelected.length} of these {deadSelected.length === 1 ? 'has' : 'have'} no
              buyer and will not sell. {deadSelected.length === 1 ? 'It' : 'They'} will fail
              {deadSelected.length === 1 ? 'its' : 'their'} own leg and come back to your
              wallet. Untick the rest to burn {deadSelected.length === 1 ? 'it' : 'them'}
              {' '}instead.
            </p>
          )}
          <CostLine
            stage={stage}
            approvals={steps.length - stepsDone}
            tokenCount={selected.length}
            resumed={stage === 'paused'}
          />
          <button
            type="button"
            onClick={() => void sweep.start()}
            disabled={
              selected.length === 0 ||
              config === null ||
              stage === 'preflight' ||
              overCeiling.length > 0
            }
            className="mt-3 h-[52px] w-full rounded-lg bg-orange text-[14px] font-semibold text-page transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-raise disabled:text-muted"
          >
            {selected.length === 0
              ? 'Nothing selected'
              : stage === 'preflight'
                ? 'Checking approvals'
                : stage === 'paused'
                  ? `Carry on, ${steps.length - stepsDone} to go`
                  : `Sweep ${selected.length} ${selected.length === 1 ? 'token' : 'tokens'}`}
          </button>
            </>
          )}
        </>
      )}

      {/* `sweep.atomic === 'ready'` used to print a dev note here about
          lib/batching.ts. Removed 6 Sep: it is not a user's concern, and
          the approval queue below already says how many prompts to
          expect. The capability is still read; nothing else changed. */}

      {SWEEPER_IS_OVERRIDDEN && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-tan">
          Sweeper address came from VITE_SWEEPER. This is a local deploy, not the
          mainnet contract.
        </p>
      )}
    </div>
  );
}

/* --- before the button ---------------------------------------------- */

/**
 * The count of wallet confirmations, said plainly, before they commit.
 * "1 signature" is the claim on the landing page and it is true. "1
 * transaction" is not, has been walked back twice, and does not come
 * back.
 */
function CostLine({
  stage,
  approvals,
  tokenCount,
  resumed,
}: {
  stage: string;
  approvals: number;
  tokenCount: number;
  resumed: boolean;
}) {
  if (tokenCount === 0) {
    return (
      <p className="text-[11.5px] leading-relaxed text-faint">
        Tick the tokens you want to sell. Each one you pick costs a one-off approval
        the first time, so picking only what pays is worth doing.
      </p>
    );
  }
  if (stage === 'preflight') {
    return (
      <p className="text-[11.5px] leading-relaxed text-muted">
        Reading your existing approvals to work out what this actually costs.
      </p>
    );
  }

  const cost =
    approvals === 0
      ? 'No approvals needed. 1 signature, then 1 sweep.'
      : `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}, then 1 signature, then 1 sweep.`;

  return (
    <div>
      <p className="text-[12px] font-medium leading-relaxed text-cream">{cost}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-faint">
        {resumed
          ? 'The approvals you already did are done and stay done.'
          : approvals === 0
            ? 'These tokens are already approved from a previous sweep.'
            : `${APPROVE_EXACT ? 'Each approval is for the exact balance shown, not unlimited. ' : ''}` +
              'Approvals stick, so stopping part way is not wasted work.'}
      </p>
    </div>
  );
}

/**
 * An EIP-7702 delegation on the connected account. Above the button and
 * before the first approval, because the whole point is that somebody
 * whose signature is going to fail finds out before paying for N
 * approvals rather than after.
 *
 * Deliberately not rendered on the receipt or in the share text. By then
 * it either worked, in which case it was noise, or it did not, in which
 * case DELEGATED_REVERT_HINT has already said it in more detail.
 */
function Delegated() {
  return (
    <div className="mb-3 rounded-md border border-teal bg-raise px-3 py-2.5">
      <p className="text-[11.5px] leading-relaxed text-muted">{DELEGATED_NOTICE}</p>
    </div>
  );
}

function Blocked({
  tokens,
  ceilingWei,
}: {
  tokens: ScannedToken[];
  ceilingWei: bigint;
}) {
  return (
    <div className="mb-3 rounded-md border border-tan/40 bg-tan/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-tan">
      <p>
        {tokens.map((t) => t.symbol).join(', ')} {tokens.length === 1 ? 'quotes' : 'quote'}{' '}
        above the contract ceiling of {formatEthTrim(ceilingWei)} ETH per token. The
        Sweeper refuses the whole batch if any single leg is worth more than that, so
        untick {tokens.length === 1 ? 'it' : 'them'} and sell{' '}
        {tokens.length === 1 ? 'it' : 'them'} somewhere that quotes them properly.
      </p>
    </div>
  );
}

/* --- during ---------------------------------------------------------- */

function InFlight({
  stage,
  steps,
  stepsDone,
  legCount,
  hash,
  onStop,
}: {
  stage: string;
  steps: { symbol: string; kind: string }[];
  stepsDone: number;
  legCount: number;
  hash: `0x${string}` | null;
  onStop: () => void;
}) {
  const current = steps[stepsDone];
  const pct =
    steps.length > 0 ? Math.round((stepsDone / steps.length) * 100) : 100;

  let headline: string;
  let detail: string;

  if (stage === 'approving') {
    headline = `Approval ${Math.min(stepsDone + 1, steps.length)} of ${steps.length}`;
    detail = current
      ? current.kind === 'reset'
        ? `Clearing the old allowance on ${current.symbol} first. Some tokens refuse to change one directly.`
        : `Approving ${current.symbol}. Check your wallet.`
      : 'Check your wallet.';
  } else if (stage === 'requoting') {
    headline = 'Re-pricing before you sign';
    detail =
      'Quotes go stale. These are read again now so the floor you sign for is one ' +
      'the pool can still honour.';
  } else if (stage === 'signing') {
    headline = 'One signature';
    detail = `Covers all ${legCount} ${legCount === 1 ? 'token' : 'tokens'} at once. It is a signature, not a transaction, and it costs no gas.`;
  } else {
    headline = 'Sweeping';
    detail = `Selling ${legCount} ${legCount === 1 ? 'token' : 'tokens'} in one sweep. Waiting for it to land.`;
  }

  return (
    <div>
      <div className="rounded-lg border border-teal bg-raise px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[12.5px] font-medium text-cream">{headline}</p>
          {stage === 'approving' && (
            <span className="num shrink-0 text-[11px] text-faint">{pct}%</span>
          )}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{detail}</p>

        {stage === 'approving' && (
          <div className="mt-2.5 h-px w-full bg-teal">
            <div
              className="h-px bg-orange transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {hash && (
          <a
            href={explorerTx(hash)}
            target="_blank"
            rel="noreferrer"
            className="num mt-2.5 inline-block text-[11px] text-faint underline decoration-teal underline-offset-2 hover:text-cream"
          >
            {shortAddress(hash)} pending
          </a>
        )}
      </div>

      {stage === 'approving' && (
        <button
          type="button"
          onClick={onStop}
          className="mt-3 h-[52px] w-full rounded-lg border border-teal text-[13px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream"
        >
          Stop after this one
        </button>
      )}
    </div>
  );
}

function Paused({
  done,
  total,
  onStartOver,
}: {
  done: number;
  total: number;
  onStartOver: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-teal bg-raise px-3 py-2.5">
      <p className="text-[12px] font-medium text-cream">
        Stopped after {done} of {total} approvals.
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
        Nothing has been sold and nothing was signed. Those {done} approvals are on
        chain and stay there, so carrying on picks up where you left off.
      </p>
      <button
        type="button"
        onClick={onStartOver}
        className="mt-2 text-[11px] text-faint underline decoration-teal underline-offset-2 hover:text-cream"
      >
        Start over instead
      </button>
    </div>
  );
}

/* --- the two places we stop and ask ---------------------------------- */

function DriftConfirm({
  rows,
  dropped,
  legs,
  totals,
  onConfirm,
  onCancel,
}: {
  rows: { token: ScannedToken; beforeWei: bigint; afterWei: bigint }[];
  dropped: { token: ScannedToken; reason: keyof typeof DROP_REASON_COPY }[];
  legs: SweepLeg[];
  totals: ReturnType<typeof legTotals>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const legCount = legs.length;
  return (
    <div className="mt-4">
      <div className="rounded-lg border border-tan/40 bg-tan/10 px-3.5 py-3">
        <p className="text-[12.5px] font-medium text-tan">
          {rows.length === 1 ? 'A price moved' : 'Prices moved'} while you were deciding
        </p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-tan">
          You have not signed anything. These are the numbers now.
        </p>

        <ul className="num mt-2.5 space-y-1 border-t border-tan/30 pt-2.5 text-[11.5px]">
          {rows.map((r) => (
            <li key={r.token.address} className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-cream">{r.token.symbol}</span>
              <span className="text-tan">
                {formatEth(r.beforeWei)} to {formatEth(r.afterWei)} ETH
              </span>
            </li>
          ))}
        </ul>
      </div>

      {dropped.length > 0 && <Dropped dropped={dropped} />}

      <p className="num mt-3 text-[12px] text-muted">
        You would now receive{' '}
        <span className="font-semibold text-cream">
          {formatEthTrim(totals.receive)} ETH
        </span>{' '}
        after the fee and gas.
      </p>

      <button
        type="button"
        onClick={onConfirm}
        className="mt-2 h-[52px] w-full rounded-lg bg-orange text-[14px] font-semibold text-page transition hover:brightness-110"
      >
        Sweep {legCount} {legCount === 1 ? 'token' : 'tokens'} at the new prices
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-2 h-10 w-full rounded-lg border border-teal text-[13px] text-muted transition-colors hover:border-orange hover:text-cream"
      >
        Cancel
      </button>
    </div>
  );
}

function Dropped({
  dropped,
}: {
  dropped: { token: ScannedToken; reason: keyof typeof DROP_REASON_COPY }[];
}) {
  return (
    <div className="mt-3 rounded-md border border-teal bg-raise px-3 py-2.5">
      <p className="text-[11.5px] text-muted">
        {dropped.length === 1 ? 'One token was' : `${dropped.length} tokens were`} left out
        of the batch:
      </p>
      <ul className="mt-1.5 space-y-1">
        {dropped.map((d) => (
          <li
            key={d.token.address}
            className="flex items-baseline justify-between gap-3 text-[11.5px]"
          >
            <span className="shrink-0 text-cream">{d.token.symbol}</span>
            <span className="min-w-0 truncate text-right text-faint">
              {DROP_REASON_COPY[d.reason]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --- when it goes wrong ---------------------------------------------- */

/**
 * The recovery copy is per stage on purpose. "Something went wrong" is
 * useless here: the user needs to know whether their tokens moved, and
 * the honest answer differs at every step.
 */
const STILL_YOURS: Record<string, string> = {
  preflight: 'Nothing was signed or sent. Your wallet is untouched.',
  approving:
    'Nothing has been sold. Any approval that already went through is still on ' +
    'chain and still counts.',
  requoting: 'Nothing was signed and nothing was sent. Every token is still yours.',
  signing: 'Nothing was sent. Your approvals are still in place.',
  sweeping:
    'Check the transaction before retrying. If it reverted, your tokens never left ' +
    'your wallet and you paid only the gas for the failed attempt.',
};

function Failure({
  message,
  stage,
  stoppedByUser,
  dropped,
  onRetry,
  canRetry,
}: {
  message: string | null;
  stage: string | null;
  stoppedByUser: boolean;
  dropped: { token: ScannedToken; reason: keyof typeof DROP_REASON_COPY }[];
  onRetry: () => void;
  canRetry: boolean;
}) {
  return (
    <div className="mt-4">
      <div className="rounded-lg border border-tan/40 bg-tan/10 px-3.5 py-3">
        <p className="text-[12.5px] font-medium text-tan">
          {stoppedByUser ? 'Stopped' : 'That did not go through'}
        </p>
        <p className="num mt-1.5 text-[11.5px] leading-relaxed text-tan">
          {message ?? 'Unknown error'}
        </p>
        {stage && STILL_YOURS[stage] && (
          <p className="mt-2 border-t border-tan/30 pt-2 text-[11.5px] leading-relaxed text-tan">
            {STILL_YOURS[stage]}
          </p>
        )}
      </div>

      {dropped.length > 0 && <Dropped dropped={dropped} />}

      <button
        type="button"
        onClick={onRetry}
        disabled={!canRetry}
        className="mt-3 h-[52px] w-full rounded-lg border border-teal text-[14px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream disabled:cursor-not-allowed disabled:opacity-50"
      >
        Try again
      </button>
    </div>
  );
}
