# dustsweep front end -- read half

Vite + React + wagmi/viem + Tailwind. No server, no API keys.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static dist/
npm run typecheck
```

## What is here

Read half only. It lists your ERC-20s, quotes each one against WETH at
all three v3 fee tiers, and sorts them into three piles. It cannot send
a transaction -- there is no Sweeper address yet.

| file | job |
|---|---|
| `src/lib/addresses.ts` | on-chain-verified address book, do not edit from memory |
| `src/lib/chain.ts` | viem chain def for 4663, incl. Multicall3 |
| `src/lib/blockscout.ts` | `GET /addresses/{a}/token-balances`, no key |
| `src/lib/quoter.ts` | QuoterV2 ABI. Note the struct field order and the `view` lie |
| `src/lib/scan.ts` | balances -> quotes -> three piles. All the actual logic |
| `src/hooks/useDustScan.ts` | the only React binding to `scan.ts` |

`src/lib/*` has no React in it. That is deliberate: if the app ever moves
to Next for dynamic OG images, only `src/components` and the hook move.

## The sort

Four piles, checked in this order. The not-dust checks run first and are
deliberately eager: when classification is uncertain the safe direction
is always "not dust".

- **notDust** -- `name()` ends in `• Robinhood Token` (U+2022), or the
  holding quotes above `NOT_DUST_CEILING_WEI` (0.1 ETH). Shown, never
  hidden, overridable one token at a time. The section's bulk select
  covers only the ceiling cases; stock tokens are individual ticks.
- **noRoute** -- every tier reverted, or the quote is zero
- **underGas** -- quotes, but does not clear gas
- **sweepable** -- net quote strictly exceeds gas cost

Live gas price x `GAS_PER_LEG` (180k) gives the cost of selling one
token. The quote gets a `QUOTE_HAIRCUT_BPS` (3%) haircut before it is
compared against that cost, and ties go to the worse pile. The ceiling
is tested against the RAW quote, not the haircut one -- the haircut
exists to be pessimistic about proceeds, and using it there would make
the guard easier to slip past.

A zero quote must never reach the adapter. `V3Adapter` reverts on
`minOut == 0` on purpose.

### Why name and not symbol

Match Robinhood tokens on `name()`, never on symbol and never on a fixed
address list. The 184-token test wallet holds a genuine `PLTR` Robinhood
Token AND a meme called "Palantir Inu" that also calls itself PLTR, plus
an `IBM` whose name is "I BUY MEMES". `name()` is re-read on-chain in the
same batch as `balanceOf`, so the guard does not depend on the indexer.

### Selection

Nothing is ever pre-checked. Selection is cleared on wallet change and on
every rescan. "Select all" touches the sweepable section only and still
needs a click.

## Verified 4 Sep 2026

Run against two real wallets on mainnet:

Piles below are sweepable / under gas / no route / not dust, at the
0.1 ETH ceiling.

- 184-token wallet: 29 / 17 / 123 / 13, 552 quote calls in ~18s on the
  public RPC with no rate limiting

At the earlier 0.01 ETH ceiling the same wallet split 13 / 17 / 125 / 29,
which is what prompted the raise.

All 9 Robinhood tokens in the big wallet were caught by name, including
PLTR and AMD which have no v3 route at all and would otherwise have been
filed as worthless. CBBTC is not a Robinhood Token ("Coinbase Wrapped
BTC") and was caught by the value ceiling instead. Both rules are load
bearing.

That second run is the argument for quoting all three tiers. NVDA, AAPL,
SPY, GME and SPCX only quote at 500; CBBTC, HIMS and TSLA only at 3000.
Quoting 10000 alone would have called all eight of them "no route".

## Palette

Sampled from the janitor artwork, contrast measured against `#0a0a0b`:

| token | hex | contrast | use |
|---|---|---|---|
| `cream` | `#f0e4cc` | 15.7:1 | primary text |
| `tan` | `#d8b377` | 10.0:1 | numbers, secondary accent |
| `orange` | `#e49054` | 7.9:1 | primary accent, the CTA |
| `muted` | `#a39b8b` | 7.2:1 | secondary copy |
| `faint` | `#8e8778` | 5.6:1 | quietest copy |
| `teal` | `#304854` | 2.1:1 | **shapes only, never text** |

Every text colour clears 4.5:1. Inside a teal-filled block `faint` drops
to 4.4:1, so use `muted` or brighter on teal. No `.text-teal` class is
generated anywhere in the build -- that is checked, not assumed.
