import { explorerToken } from '../lib/chain';
import { formatEth, formatEthTrim, formatTokenAmount } from '../lib/format';
import type { ScannedToken } from '../lib/scan';

const TIER_LABEL: Record<number, string> = {
  10000: '1%',
  3000: '0.3%',
  500: '0.05%',
};

/**
 * One line, always. At 560px the symbol truncates rather than wrapping,
 * because a list where some rows are two lines tall reads as broken.
 *
 * Not-dust rows trade the value column and the tier badge for a single
 * reason column. "Robinhood stock token" and "worth 4.72 ETH" are two
 * different situations and the user has to be able to tell them apart
 * at the moment they decide to override one.
 */
export function TokenRow({
  token,
  checked,
  onToggle,
}: {
  token: ScannedToken;
  checked: boolean;
  onToggle: (address: `0x${string}`) => void;
}) {
  const noRoute = token.pile === 'noRoute';
  const notDust = token.pile === 'notDust';

  return (
    <label
      className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-[7px] transition-colors hover:bg-raise ${
        checked ? 'bg-raise' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(token.address)}
        className="size-[15px] shrink-0 accent-orange"
      />

      <span
        className="min-w-0 flex-1 truncate text-[13px] text-cream"
        title={`${token.symbol} — ${token.onChainName}`}
      >
        {token.symbol}
      </span>

      <span className="num w-[80px] shrink-0 truncate text-right text-[12px] text-faint">
        {formatTokenAmount(token.balance, token.decimals)}
      </span>

      {notDust ? (
        <span className="num w-[148px] shrink-0 truncate text-right text-[11px] text-tan">
          {token.notDustReason === 'robinhoodToken'
            ? 'Robinhood stock token'
            : `worth ${formatEthTrim(token.netOutWei)} ETH`}
        </span>
      ) : (
        <>
          <span
            className={`num w-[94px] shrink-0 text-right text-[12px] ${
              noRoute ? 'text-faint' : 'text-tan'
            }`}
          >
            {noRoute ? 'no quote' : formatEth(token.netOutWei)}
          </span>
          <span className="w-[50px] shrink-0 text-right">
            {token.bestFee !== null ? (
              <span className="num rounded bg-teal/35 px-1.5 py-0.5 text-[10px] text-muted">
                {TIER_LABEL[token.bestFee] ?? token.bestFee}
              </span>
            ) : (
              <a
                href={explorerToken(token.address)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-faint hover:text-cream"
              >
                view
              </a>
            )}
          </span>
        </>
      )}
    </label>
  );
}
