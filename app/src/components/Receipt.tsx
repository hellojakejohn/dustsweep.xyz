import { useState } from 'react';
import { explorerTx } from '../lib/chain';
import { formatEth, formatEthTrim, formatTokenAmount, shortAddress } from '../lib/format';
import type { SweepReceipt } from '../lib/sweeper';
import type { ScannedToken } from '../lib/scan';

/**
 * What actually happened. This is the share card and the distribution
 * plan, so it does not get corners cut.
 *
 * It reports the events, not the request. A sweep where 9 of 12 legs
 * filled is a success and the other three are back in the wallet, and
 * saying so is the entire reason anyone would trust the number next to
 * it. Hiding the three is how you lose the one thing this project has.
 */
export function Receipt({
  receipt,
  feeBps,
  tokens,
  onScanAgain,
}: {
  receipt: SweepReceipt;
  feeBps: bigint;
  /** The scan rows, to put a symbol on a failed leg's address. */
  tokens: ScannedToken[];
  onScanAgain: () => void;
}) {
  const symbolFor = (addr: string) =>
    tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase())?.symbol ??
    shortAddress(addr);

  const tokenFor = (addr: string) =>
    tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  const failedCount = receipt.legsAttempted - receipt.legsFilled;
  const allFilled = failedCount === 0;
  const returned = receipt.failed.filter((f) => f.returned);
  const stranded = receipt.stranded;

  return (
    <div className="mt-4">
      <div className="rounded-lg border border-teal bg-raise px-4 py-4">
        <p className="text-[11px] uppercase tracking-wide text-faint">Landed in your wallet</p>
        <p className="num mt-1 text-[26px] font-semibold leading-none text-cream">
          {formatEthTrim(receipt.userOutWei)} ETH
        </p>

        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          {allFilled
            ? `All ${receipt.legsFilled} of ${receipt.legsAttempted} sold.`
            : `${receipt.legsFilled} of ${receipt.legsAttempted} sold.`}
          {/* "went back to your wallet" is not true of a token that
              refuses every transfer out, so the two outcomes are counted
              separately and never merged into one reassuring sentence. */}
          {returned.length > 0 &&
            ` ${returned.length === 1 ? 'One token' : `${returned.length} tokens`} found no buyer and went back to your wallet.`}
          {stranded.length > 0 &&
            ` ${stranded.length === 1 ? 'One' : String(stranded.length)} could not be sent back at all.`}
        </p>

        <dl className="num mt-3 space-y-1.5 border-t border-teal pt-3 text-[12px]">
          <Row label="Gross" value={`${formatEth(receipt.grossWei)} ETH`} />
          <Row
            label={`Fee ${Number(feeBps) / 100}%`}
            value={`-${formatEth(receipt.feeWei)} ETH`}
          />
          {/* This transaction only. The approvals were paid for
              separately and are already spent, so folding them in here
              would be inventing a number. */}
          <Row label="Gas, this transaction" value={`-${formatEth(receipt.gasUsedWei)} ETH`} />
        </dl>

        {returned.length > 0 && (
          <div className="mt-3 border-t border-teal pt-3">
            <p className="text-[11px] text-muted">
              Returned to your wallet, still yours:
            </p>
            <ul className="mt-1.5 space-y-1">
              {returned.map((f) => (
                <li
                  key={f.token}
                  className="flex items-baseline justify-between gap-3 text-[11.5px]"
                >
                  <span className="shrink-0 text-cream">{symbolFor(f.token)}</span>
                  <span className="num min-w-0 truncate text-right text-faint" title={f.reason}>
                    {f.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {stranded.length > 0 && (
          <div className="mt-3 rounded-md border border-tan/40 bg-tan/10 px-3 py-2.5">
            <p className="text-[11.5px] font-medium text-tan">
              {stranded.length === 1 ? 'This token is' : 'These tokens are'} stuck in the
              contract and {stranded.length === 1 ? 'is' : 'are'} not coming back
            </p>
            <ul className="mt-1.5 space-y-1">
              {stranded.map((f) => {
                const t = tokenFor(f.token);
                return (
                  <li
                    key={f.token}
                    className="flex items-baseline justify-between gap-3 text-[11.5px]"
                  >
                    <span className="shrink-0 text-cream">{symbolFor(f.token)}</span>
                    <span className="num min-w-0 truncate text-right text-tan">
                      {f.strandedAmount !== null && t
                        ? formatTokenAmount(f.strandedAmount, t.decimals)
                        : String(f.strandedAmount ?? '')}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-tan">
              {stranded.length === 1 ? 'It' : 'They'} refused to sell and then refused to
              be sent back, which is how a honeypot behaves. The Sweeper handed the rest of
              the batch back rather than reverting everything over{' '}
              {stranded.length === 1 ? 'it' : 'them'}. Nobody can retrieve{' '}
              {stranded.length === 1 ? 'it' : 'them'} from the contract, including us.
            </p>
          </div>
        )}

        <a
          href={explorerTx(receipt.hash)}
          target="_blank"
          rel="noreferrer"
          className="num mt-3 inline-block text-[11px] text-muted underline decoration-teal underline-offset-2 transition-colors hover:text-cream"
        >
          {shortAddress(receipt.hash)} on Blockscout
        </a>
      </div>

      <Share receipt={receipt} />

      <button
        type="button"
        onClick={onScanAgain}
        className="mt-3 h-[52px] w-full rounded-lg border border-teal text-[14px] font-semibold text-muted transition-colors hover:border-orange hover:text-cream"
      >
        Scan again
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-faint">{label}</dt>
      <dd className="text-muted">{value}</dd>
    </div>
  );
}

/**
 * The share text says the failed legs out loud too. A card that only
 * ever reports clean sweeps is an advert; one that reports "9 of 12, the
 * other 3 came back" is the reason to believe the 9.
 */
export function shareText(receipt: SweepReceipt): string {
  const returned = receipt.failed.filter((f) => f.returned).length;
  const stranded = receipt.stranded.length;
  const head = `Swept ${receipt.legsFilled} dead ${
    receipt.legsFilled === 1 ? 'token' : 'tokens'
  } off Robinhood Chain for ${formatEthTrim(receipt.userOutWei)} ETH.`;

  // Never "one transaction": there were N approvals in front of it and
  // that claim has already been walked back twice. And the stranded
  // count goes in the shared text, not just the private screen. A card
  // that only ever reports the good half is an advert.
  const parts: string[] = [];
  if (returned > 0) parts.push(`${returned} had no buyer and came straight back`);
  if (stranded > 0) {
    parts.push(`${stranded} turned out to be ${stranded === 1 ? 'a honeypot' : 'honeypots'} and could not even be returned`);
  }
  const tail = parts.length > 0 ? ` ${parts.join(', ')}.` : ' One signature covered the lot.';
  return `${head}${tail}\n\ndustsweep.xyz`;
}

function Share({ receipt }: { receipt: SweepReceipt }) {
  const [copied, setCopied] = useState(false);
  const text = shareText(receipt);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked in plenty of contexts and there is nothing
      // to recover. The text is in the tweet link either way.
    }
  };

  return (
    <div className="mt-3 flex gap-2">
      <a
        href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`}
        target="_blank"
        rel="noreferrer"
        className="flex h-10 flex-1 items-center justify-center rounded-lg bg-orange text-[13px] font-semibold text-page transition hover:brightness-110"
      >
        Post it
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        className="h-10 shrink-0 rounded-lg border border-teal px-4 text-[13px] text-muted transition-colors hover:border-orange hover:text-cream"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
