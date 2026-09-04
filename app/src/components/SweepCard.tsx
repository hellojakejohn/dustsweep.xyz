import { useEffect, useMemo, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { useDustScan } from '../hooks/useDustScan';
import { chainName, robinhoodChain } from '../lib/chain';
import { formatEth, formatEthTrim } from '../lib/format';
import {
  NOT_DUST_CEILING_WEI,
  QUOTE_HAIRCUT_BPS,
  SWEEP_FEE_BPS,
  totalsFor,
  type Pile,
  type ScannedToken,
} from '../lib/scan';
import { ConnectButton } from './Connect';
import { Section } from './Section';
import { TokenRow } from './TokenRow';

/** Pile dots. These are shapes, so teal is allowed here. */
const DOT: Record<Pile, string> = {
  sweepable: 'bg-orange',
  underGas: 'bg-tan',
  noRoute: 'bg-teal',
  notDust: 'bg-cream',
};

const SECTIONS: {
  pile: Pile;
  title: string;
  note: string;
  openByDefault: boolean;
}[] = [
  {
    pile: 'sweepable',
    title: 'Worth sweeping',
    openByDefault: true,
    note: 'Quotes clear what it costs in gas to sell them.',
  },
  {
    pile: 'underGas',
    title: 'Costs more than it is worth',
    openByDefault: false,
    note: 'These have a real price. Selling them loses you money.',
  },
  {
    pile: 'noRoute',
    title: 'No route out',
    openByDefault: false,
    note: 'No pool at 1%, 0.3% or 0.05%, or the quote rounds to zero.',
  },
  {
    pile: 'notDust',
    title: 'Not dust',
    openByDefault: false,
    note: 'These look like real assets. dustsweep will not touch them unless you say so. Ticking one here selects it for sale at the value shown.',
  },
];

export function SweepCard({ onStatus }: { onStatus: (line: string) => void }) {
  // `useAccount().chainId` is the chain the WALLET is on. `useChainId()`
  // is not: wagmi clamps that to a configured chain and, in its own
  // words, "if chain is not configured, then don't switch over to it".
  // With 4663 as the only configured chain it therefore reads 4663 no
  // matter where the wallet actually is, which made the whole wrong-chain
  // branch below unreachable -- a visitor on Ethereum went straight to
  // scanning. Verified headless: a wallet reporting 0x1 got the scan.
  const { address, chainId, isConnected } = useAccount();
  const onRightChain = chainId === robinhoodChain.id;
  const scan = useDustScan(isConnected && onRightChain ? address : undefined);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Record<Pile, boolean>>(() =>
    Object.fromEntries(SECTIONS.map((s) => [s.pile, s.openByDefault])) as Record<
      Pile,
      boolean
    >,
  );

  // Nothing survives a wallet change or a rescan. A checkbox the user
  // did not tick in this scan must never be able to end up in a permit.
  useEffect(() => setSelected(new Set()), [address]);
  useEffect(() => {
    if (scan.phase === 'listing') setSelected(new Set());
  }, [scan.phase]);

  const piles = useMemo(() => {
    const byPile: Record<Pile, ScannedToken[]> = {
      sweepable: [],
      underGas: [],
      noRoute: [],
      notDust: [],
    };
    for (const t of scan.tokens) byPile[t.pile].push(t);
    return byPile;
  }, [scan.tokens]);

  const selectedTokens = useMemo(
    () => scan.tokens.filter((t) => selected.has(t.address)),
    [scan.tokens, selected],
  );
  const totals = totalsFor(selectedTokens, scan.gasCostPerLegWei);

  const scanning = scan.phase === 'listing' || scan.phase === 'quoting';
  const hasRows = scan.tokens.length > 0;

  useEffect(() => {
    if (!isConnected) return onStatus('');
    if (!onRightChain) return onStatus(`Wallet is on ${chainName(chainId)}.`);
    if (scan.phase === 'listing') return onStatus('Reading your token balances.');
    if (scan.phase === 'quoting') {
      return onStatus(
        `Quoting ${scan.found} tokens at three fee tiers. ${scan.quoted} done.`,
      );
    }
    if (scan.phase === 'error') return onStatus('Scan failed.');
    if (scan.phase === 'done') {
      return onStatus(
        `Scanned ${scan.found} tokens. Quotes carry a ${Number(QUOTE_HAIRCUT_BPS) / 100}% haircut before they are compared to gas.`,
      );
    }
    onStatus('');
  }, [isConnected, onRightChain, chainId, scan.phase, scan.found, scan.quoted, onStatus]);

  const toggle = (addr: `0x${string}`) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });

  return (
    <div className="w-full max-w-[560px] rounded-[18px] border border-teal bg-card p-[22px]">
      {!isConnected ? (
        <Disconnected />
      ) : !onRightChain ? (
        <WrongChain chainId={chainId} />
      ) : scan.phase === 'error' ? (
        <ScanError message={scan.error} onRetry={() => void scan.rescan()} />
      ) : (
        <div className="flex min-h-[288px] flex-col">
          {scanning && <Progress found={scan.found} quoted={scan.quoted} phase={scan.phase} />}

          {!hasRows && !scanning ? (
            <Empty onRescan={() => void scan.rescan()} />
          ) : !hasRows ? (
            <div className="grow" />
          ) : (
            <>
              <div className="-mx-1 max-h-[50vh] grow overflow-y-auto px-1">
                {SECTIONS.map((s) => (
                  <Section
                    key={s.pile}
                    title={s.title}
                    count={piles[s.pile].length}
                    dot={DOT[s.pile]}
                    guarded={s.pile === 'notDust'}
                    note={s.note}
                    open={open[s.pile]}
                    onToggle={() =>
                      setOpen((prev) => ({ ...prev, [s.pile]: !prev[s.pile] }))
                    }
                    action={
                      s.pile === 'sweepable' && piles.sweepable.length > 0 ? (
                        <BulkSelect
                          tokens={piles.sweepable}
                          selected={selected}
                          setSelected={setSelected}
                          label="Select all"
                        />
                      ) : s.pile === 'notDust' ? (
                        <NotDustSelect
                          tokens={piles.notDust}
                          selected={selected}
                          setSelected={setSelected}
                        />
                      ) : null
                    }
                  >
                    {piles[s.pile].map((t) => (
                      <TokenRow
                        key={t.address}
                        token={t}
                        checked={selected.has(t.address)}
                        onToggle={toggle}
                      />
                    ))}
                  </Section>
                ))}
              </div>

              <Totals
                totals={totals}
                dangerCount={selectedTokens.filter((t) => t.pile === 'notDust').length}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

type SetSelected = (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;

function applyBulk(tokens: ScannedToken[], turnOn: boolean): (p: ReadonlySet<string>) => Set<string> {
  return (prev) => {
    const next = new Set(prev);
    for (const t of tokens) {
      if (turnOn) next.add(t.address);
      else next.delete(t.address);
    }
    return next;
  };
}

function BulkSelect({
  tokens,
  selected,
  setSelected,
  label,
}: {
  tokens: ScannedToken[];
  selected: ReadonlySet<string>;
  setSelected: SetSelected;
  label: string;
}) {
  const allOn = tokens.length > 0 && tokens.every((t) => selected.has(t.address));
  return (
    <button
      type="button"
      onClick={() => setSelected(applyBulk(tokens, !allOn))}
      className="shrink-0 rounded border border-teal px-2 py-1 text-[11px] text-muted transition-colors hover:border-orange hover:text-cream"
    >
      {allOn ? 'Clear' : label}
    </button>
  );
}

/**
 * Bulk select for the not-dust section, deliberately narrower than the
 * others: it only ever touches tokens held back by the value ceiling.
 *
 * Robinhood stock tokens are excluded on purpose. They are never dust at
 * any price, so there is no batch under which selecting all of them is
 * the right call. Those stay individual ticks.
 */
function NotDustSelect({
  tokens,
  selected,
  setSelected,
}: {
  tokens: ScannedToken[];
  selected: ReadonlySet<string>;
  setSelected: SetSelected;
}) {
  const selectable = tokens.filter((t) => t.notDustReason === 'aboveCeiling');
  if (selectable.length === 0) return null;

  const allOn = selectable.every((t) => selected.has(t.address));
  const combined = selectable.reduce((sum, t) => sum + t.netOutWei, 0n);

  return (
    <button
      type="button"
      onClick={() => setSelected(applyBulk(selectable, !allOn))}
      className="num shrink-0 rounded border border-teal px-2 py-1 text-[11px] text-tan transition-colors hover:border-orange hover:text-cream"
      title="Robinhood stock tokens are not included. Tick those individually."
    >
      {allOn
        ? `Clear ${selectable.length}`
        : `Select ${selectable.length} · ${formatEthTrim(combined)} ETH`}
    </button>
  );
}

function Totals({
  totals,
  dangerCount,
}: {
  totals: ReturnType<typeof totalsFor>;
  dangerCount: number;
}) {
  const feePct = Number(SWEEP_FEE_BPS) / 100;
  const haircutPct = Number(QUOTE_HAIRCUT_BPS) / 100;

  return (
    <div className="mt-3 border-t border-teal pt-4">
      <dl className="num space-y-1.5 text-[12px]">
        <Line label="Selected" value={`${totals.count} tokens`} />
        <Line label="Gross" value={`${formatEth(totals.gross)} ETH`} />
        <Line label="Gas (est)" value={`${formatEth(totals.gas)} ETH`} negative />
        <Line label={`Fee ${feePct}%`} value={`${formatEth(totals.fee)} ETH`} negative />
        <div className="!mt-2.5 border-t border-teal pt-2.5">
          <Line
            label="You receive"
            value={`${totals.receive < 0n ? '-' : ''}${formatEth(
              totals.receive < 0n ? -totals.receive : totals.receive,
            )} ETH`}
            strong
            bad={totals.receive <= 0n && totals.count > 0}
          />
        </div>
      </dl>

      {dangerCount > 0 && (
        <p className="mt-3 rounded-md border border-tan/40 bg-tan/10 px-3 py-2 text-[11px] leading-relaxed text-tan">
          {dangerCount === 1 ? '1 token' : `${dangerCount} tokens`} you selected{' '}
          {dangerCount === 1 ? 'is' : 'are'} in the Not dust section. Check the value before
          you sign.
        </p>
      )}

      <button
        type="button"
        disabled
        className="mt-4 h-[52px] w-full cursor-not-allowed rounded-lg border border-dashed border-teal bg-raise text-[14px] font-semibold text-muted"
      >
        Contract not deployed yet
      </button>

      <p className="mt-2.5 text-[11px] text-faint">
        Non-custodial. Unaudited. Source is public.
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-faint">
        Quotes carry a {haircutPct}% haircut. Gas is paid from your ETH balance, not out of
        the proceeds.
      </p>
    </div>
  );
}

function Line({
  label,
  value,
  negative,
  strong,
  bad,
}: {
  label: string;
  value: string;
  negative?: boolean;
  strong?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'text-muted' : 'text-faint'}>{label}</dt>
      <dd
        className={
          strong
            ? `text-[14px] font-semibold ${bad ? 'text-tan' : 'text-cream'}`
            : 'text-muted'
        }
      >
        {negative && value !== '0 ETH' ? '-' : ''}
        {value}
      </dd>
    </div>
  );
}

const STATS = [
  { value: '~63,000', label: 'tokens stranded on this chain' },
  { value: '2', label: 'launchpads that shut their front ends' },
  { value: '1', label: 'signature to clear yours' },
];

const LEGEND: { pile: Pile; title: string; body: string }[] = [
  { pile: 'sweepable', title: 'Worth sweeping', body: 'the quote clears the gas to sell it' },
  {
    pile: 'underGas',
    title: 'Costs more than it is worth',
    body: 'priced, but selling loses you money',
  },
  { pile: 'noRoute', title: 'No route out', body: 'no pool at any of the three fee tiers' },
];

function Disconnected() {
  return (
    <div className="flex flex-col">
      <p className="text-[13px] leading-relaxed text-muted">
        Find every dead token in your wallet, price each one against a live pool, and see
        which are actually worth selling.
      </p>

      <dl className="mt-5 grid grid-cols-3 gap-3">
        {STATS.map((s) => (
          <div key={s.label}>
            <dd className="num text-[22px] font-semibold leading-none text-tan">
              {s.value}
            </dd>
            <dt className="mt-1.5 text-[10.5px] leading-snug text-faint">{s.label}</dt>
          </div>
        ))}
      </dl>

      <ul className="mt-5 space-y-1.5 border-t border-teal pt-4">
        {LEGEND.map((l) => (
          <li key={l.pile} className="flex items-baseline gap-2 text-[11.5px]">
            <span
              className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT[l.pile]}`}
              aria-hidden="true"
            />
            <span className="text-cream">{l.title}</span>
            <span className="min-w-0 truncate text-faint">{l.body}</span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        Holdings worth more than {formatEthTrim(NOT_DUST_CEILING_WEI)} ETH, and anything
        Robinhood issued, are held back in a fourth pile as not dust.
      </p>

      <p className="mt-2 text-[11px] leading-relaxed text-faint">
        One signature covers the whole batch. Each token also needs a one-off approval the
        first time you sweep it, so a fresh wallet pays those first, then signs once, then
        sends one transaction.
      </p>

      <img
        src="/janitor-full.png"
        alt=""
        className="mt-4 h-[120px] w-full object-contain"
      />

      <div className="mt-4">
        <ConnectButton full />
        <p className="mt-2.5 text-[11px] text-faint">Read-only. Nothing is signed or sent.</p>
      </div>
    </div>
  );
}

/**
 * The state a first-time visitor actually lands in. Phantom supports this
 * chain but nobody arrives already on it, so this screen has to do the
 * switch itself -- if the wallet has never seen 4663, wagmi turns the
 * request into an add-chain prompt using `robinhoodChain`'s own RPC and
 * explorer. Naming a network and leaving the user to find the setting is
 * how you lose them here.
 */
function WrongChain({ chainId }: { chainId: number | undefined }) {
  const { switchChain, isPending, error } = useSwitchChain();
  return (
    <div className="flex min-h-[288px] flex-col">
      <p className="text-[13px] leading-relaxed text-muted">
        Your wallet is on {chainName(chainId)}. dustsweep only reads{' '}
        {robinhoodChain.name}.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-faint">
        Switching adds {robinhoodChain.name} to your wallet if it is not there yet. It is a
        network change, not an approval, and nothing is signed.
      </p>
      <div className="grow" />
      {error && (
        <p className="mt-4 rounded-md border border-tan/40 bg-tan/10 px-3 py-2 text-[11px] leading-relaxed text-tan">
          The wallet did not switch. Approve the prompt, or add {robinhoodChain.name} by
          hand and come back.
        </p>
      )}
      <button
        type="button"
        onClick={() => switchChain({ chainId: robinhoodChain.id })}
        disabled={isPending}
        className="mt-6 h-[52px] w-full rounded-lg bg-orange text-[14px] font-semibold text-page transition hover:brightness-110 disabled:opacity-60"
      >
        {isPending ? 'Check your wallet' : `Switch to ${robinhoodChain.name}`}
      </button>
    </div>
  );
}

function ScanError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="flex min-h-[288px] flex-col">
      <p className="text-[13px] font-medium text-cream">Scan failed</p>
      <p className="num mt-2 text-[11px] leading-relaxed text-muted">
        {message ?? 'Unknown error'}
      </p>
      <div className="grow" />
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 h-[52px] w-full rounded-lg border border-teal text-[14px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream"
      >
        Try again
      </button>
    </div>
  );
}

function Empty({ onRescan }: { onRescan: () => void }) {
  return (
    <div className="flex min-h-[288px] flex-col">
      <p className="text-[13px] font-medium text-cream">No dust found.</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Either your wallet is clean or it never touched a launchpad.
      </p>
      <div className="grow" />
      <button
        type="button"
        onClick={onRescan}
        className="mt-6 h-[52px] w-full rounded-lg border border-teal text-[14px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream"
      >
        Scan again
      </button>
    </div>
  );
}

function Progress({
  found,
  quoted,
  phase,
}: {
  found: number;
  quoted: number;
  phase: string;
}) {
  const pct = found > 0 ? Math.min(100, Math.round((quoted / found) * 100)) : 0;
  return (
    <div className="mb-1 pb-3">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">
          {phase === 'listing' ? 'Reading balances' : 'Quoting'}
        </span>
        <span className="num text-faint">
          {phase === 'listing' ? '' : `${quoted} of ${found} quoted`}
        </span>
      </div>
      <div className="mt-2 h-px w-full bg-teal">
        <div
          className="h-px bg-orange transition-[width] duration-300"
          style={{ width: `${phase === 'listing' ? 4 : pct}%` }}
        />
      </div>
    </div>
  );
}
