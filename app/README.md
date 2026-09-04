# dustsweep front end -- read half

Vite + React + wagmi/viem + Tailwind. No server, no API keys.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static dist/
npm run typecheck
```

Point the whole app at an anvil fork with one env var:

```
VITE_RPC_URL=http://127.0.0.1:8545 npm run dev
```

It feeds both the viem transport and `robinhoodChain.rpcUrls`, so the RPC
a wallet is asked to *add* the chain with follows the fork too and the
wallet is never reading a different node than the app. Unset -- including
every production build -- nothing changes. When it is set the header
carries a `local fork` badge at every breakpoint, on purpose: demoing a
forked chain that looks exactly like mainnet has burned people.

`.env.local` is gitignored here and at the repo root. Do not commit one.

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
| `src/lib/rpc.ts` | resolves `VITE_RPC_URL`, the local-fork override |
| `src/hooks/useDustScan.ts` | the only React binding to `scan.ts` |
| `src/components/Connect.tsx` | wallet picker over wagmi's EIP-6963 connectors |

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

Connect, picker, wrong-chain and RPC-override behaviour were driven in
headless Chrome over CDP against a `dist/` build, with fake EIP-6963
wallets announced into the page: 42 behaviour assertions across 12 cases,
7 more for the env var, and a contrast audit that walks the rendered DOM
and composites each text colour against what is actually painted behind
it -- 147 text elements across 7 states, zero below 4.5:1 (3:1 for large
text), tightest margin 0.70 over its own threshold.

None of it is trusted on a first green. The suite was mutation-tested:
restoring `connectors[0]` (which reconnected the wrong wallet, exactly
Jake's bug), dropping the Escape handler, reverting to `useChainId()`,
keeping the generic shim in the list, and removing the Safari blur guard
each turned the assertions that cover them red, then the source was
restored. The contrast auditor was checked the same way, against an
injected teal-on-card label.

The scan itself was run against two real wallets on mainnet:

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

## Connecting

`connectors[0]` was picking whichever extension won the injection race.
With Phantom and MetaMask both installed the button went to MetaMask with
no way to choose.

wagmi discovers every installed wallet over EIP-6963 and appends one
connector per wallet keyed by rdns, so the fix needs no new dependency --
no RainbowKit, no WalletConnect project id. The picker costs ~4 KB.

- One wallet: connects straight to it. A list of one is not a choice.
- More than one: a small menu, wallet name and its EIP-6963 icon, in the
  header and in the card both. Escape or a click outside dismisses it,
  the first option takes focus on open, arrows move between them.
- None: the "No wallet detected" link. **That branch used to be dead** --
  our own `injected()` shim is in the config whether or not anything
  injected, so `connectors` is never empty. It is now gated on there
  actually being a `window.ethereum`, rechecked once after mount for
  wallets that inject late.
- The last wallet used is remembered in `localStorage` and floats to the
  top. Every read and write is wrapped: some browsers throw on access.

The generic shim is hidden whenever discovery found real wallets, or it
would sit in the list as an unnamed fourth entry duplicating one of the
other three.

### Two traps found while building it

**`useChainId()` is not the wallet's chain.** wagmi clamps it to a
configured chain -- "if chain is not configured, then don't switch over
to it" -- so with 4663 as the only configured chain it read 4663 no
matter where the wallet actually was. `SweepCard` used it to decide
`onRightChain`, which made the entire wrong-chain branch unreachable: a
visitor sitting on Ethereum went straight to scanning. Use
`useAccount().chainId`, which is the connection's real chain.

**Do not close the picker on a bare blur.** macOS Safari does not focus a
button on mousedown and blurs whatever had focus to the body, so a blur
with a null `relatedTarget` arrives *between* mousedown and click. Close
on that and the menu unmounts before the click lands -- the picker cannot
be used with a mouse in Safari at all. Only a blur that names where focus
went counts.

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
