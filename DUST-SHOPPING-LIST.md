# Dust shopping list

You cannot test a dust sweeper without dust. This is the remaining Block 1
item and it is a hard blocker on Block 2 fork tests and Block 4 self-sweep.
**Only you can do this. It needs your wallet and your funds.**

Buy a small amount of 4 or 5 of these. Spend a few dollars each, not more.
The point is to own the token, not to invest.

All verified live on 4 Sep 2026: WETH-paired, fee tier 10000, pool funded,
QuoterV2 returns a real quote.

## Noxa tokens (the main target -- launchpad is dead, no UI to sell through)

| Token | Pool WETH | Notes |
|---|---|---|
| `0x955b339944CbD4834156366D766C260C80956B44` | 0.585 | deepest of the sampled set |
| `0x5dDfeB98Cb3b19eefABde82608aE5574049E9C05` | 0.169 | |
| `0x73490dDdb4E8fe72Ddf744214b3678aD8eDDBDdD` | 0.113 | |
| `0x2AE3f3fc7f6ab2eFE68a8a3690555DB0a51B23cF` | 0.064 | |
| `0x3bcd83890a3F1aFaF5D9A374c170353559aFC9A6` | 0.062 | |
| `0x00e608488d2aA0FfeEa12FdEACF487af3141AA4D` | 0.047 | thinnest, good for the "under gas" pile |

## Pons V1 tokens (same code path, different factory)

| Token | Pool WETH |
|---|---|
| `0x97133372cC4391A4F6889b4d52387649B76BC7EC` | 0.546 |
| `0x6B2A210E2cd1Bb404C1E208D4f7e0a7d91F68A49` | 0.020 |
| `0x7d9A28293BAcf0472821a73651259d7798A589D1` | 0.017 |

## Get a good spread

Buy at least one from each end: one with a fat pool (0.5+ WETH) and one
with a thin pool (under 0.05). You need both piles represented or you
cannot test the sort.

Grab one Pons V1 and one Noxa so the multi-factory indexing gets exercised.

## The weird one: BOW

**Buy this one.** Verified on chain 5 Sep 2026.

```
BOW   0x9b1c8c5cbC20316fc311F00a6248B6bCF950ed8a   18 decimals
pool  0xae226E172AEe98d7812f7c68EEbD5305E2550d1C   fee tier 10000
depth 3.828 WETH
```

3.8 WETH is deeper than every other pool on this page, so a few dollars
buys you a real position and barely moves the price.

**What is wrong with it: `transfer` only works when the recipient is the
Uniswap pool.** Anything else reverts with the string
`Transfers locked until graduation`. It is not from Noxa, Pons V1 or Pons
V2 -- `getLaunchedToken(BOW)` returns the zero address on all three
factories, so this is an independently deployed contract, and
`graduated()` is not part of its ABI (the call reverts with `0x`).

This is the exact shape that defeats the three-pile sort, which is why it
is worth buying:

- QuoterV2 quotes it perfectly happily. 3.4e24 BOW, which is what 0.01
  WETH buys, quotes **0.0097 WETH** on the 1% tier. That is ~44x one leg
  of gas, so the front end puts it confidently in **"worth sweeping"**.
- The sweep then reverts. `Sweeper.sweep` moves the token to the Sweeper
  via the Permit2 batch, and the Sweeper is not the pool.
- A plain Uniswap swap from your own wallet **succeeds**, because
  SwapRouter02 pulls the token straight from you into the pool and never
  custodies it. So the token is not broken, it is specifically hostile to
  any contract that has to hold it mid-flight, which is exactly what a
  batched sweeper does.

That makes it the test case CLAUDE.md non-negotiable 4 asks for: a
deliberately broken token in the batch, exercising the try/catch path.
It should end up in the "no route out" pile, and the honest fix is for
the preflight to simulate the actual `transferFrom`, not just the quote.

Verified with, in order: `transfer` and `transferFrom` to an EOA both
revert, both to the pool succeed (anvil fork, real mainnet state);
`eth_call` of `transfer` with `--from` the real holder
`0x29e1dFE55ae0Ab953D424f62A0625149BC39b068` reverts the same way on
mainnet with no fork involved; buy and sell through SwapRouter02 both
succeed on the fork.

### Second one of the same class, if you want two

```
FRENS 0x2702a57bA3D6568320F5D7C57f360dFa5763f8A9   18 decimals
pool  0x7EdA9a5D56D2e50CD21AEAE02f248BAA4dB0bbC6   fee tier 10000
depth 0.0798 WETH
```

Same rule, different implementation: reverts with the custom error
`InvalidTransfer()` (`0x2f352531`) rather than a string, and the thin
pool puts it near the under-gas boundary. Two tokens means the try/catch
path is tested against both a string revert and a custom error, which
decode differently.

### Also worth owning, cheap

```
4663.wtf      0x9f2D7e134AF234c737e9E42A89A8CbBaa156a5BA  0 decimals   0.0082 WETH  fee 10000
STONKEXCHANGE 0x5d111f5083c89589009d1d64eAdD84dc615836B4  11 decimals  0.2916 WETH  fee 10000
```

Both buy and sell cleanly on the fork. `4663.wtf` covers the 0-decimals
case from the checklist, where an amount and its display value are the
same number and any `/ 1e18` in the UI is instantly visible.
STONKEXCHANGE covers non-standard non-zero decimals. No 24-decimal token
exists on this chain that holds a WETH pool.

### Two you cannot buy, listed so nobody re-hunts them

```
Stock Coin 0x4ec7150FC4f2090a8F3352dF6cf4D8a206749304  0.604 WETH  fee 10000
$1         0x8c515613d4910A989d1465f931bB5004B42cCCf7  0 WETH      pools at 10000 and 500
```

**Stock Coin** reverts every transfer with `MarketClosed(uint256)`, and
the argument is a timestamp telling you when it reopens. On 5 Sep it
returned `1788787800` = **Mon 7 Sep 2026 13:30 UTC**, which is 9:30 ET,
US market open. It is transferable during US equity market hours and not
otherwise. Worth knowing this class exists on a Robinhood chain: it is a
token that passes every test on a Tuesday afternoon and fails the same
test on a Saturday. The buy failed on the fork for the same reason.

**`$1`** ("$1 is all you need") is the zero-liquidity case from the
checklist. Pools exist at both 10000 and 500, both hold 0 WETH, and
QuoterV2 reverts with `Unexpected error`. You cannot buy it, so it
cannot go in a wallet, but the address is here if you want to point a
quote at it directly. 74 tokens in the scanned set are in this state.

### What is NOT on this chain

Scanned all **10,901** tokens that hold a WETH pool with at least 0.01
WETH, simulating a real `transfer` on each one via `eth_call` with a
state override that injects a probe contract at a genuine holder's
address. No transaction was sent.

- **fee-on-transfer: zero found.** Not one token delivered less than it
  was sent.
- **`transfer` returning `false` instead of reverting: zero found.**
- **rebasing: not tested.** Detecting it needs two reads separated in
  time, which this pass did not do.

Do not go shopping for a fee-on-transfer token here. The chain's dust is
overwhelmingly Noxa and Pons template tokens, which are plain ERC-20s.
Known gap 2 in CLAUDE.md (no fee-on-transfer token in the Sweeper batch
suite) cannot be closed with a real token from this chain; it needs a
mock.

Caveat on that scan: the probe capped each `transfer` at 400k gas, so a
token needing more shows up as a revert rather than as its real
behaviour. Four did. Three were the locked tokens above. The fourth,
CashBack Cat `0xFf8efFDd6332B283f83f5e4B6f3580445fC93362`, transfers
cleanly with no fee once the cap is raised to 8M, so it is not hostile,
just expensive. Its `transfer` costing over 400k gas is worth
remembering when sizing gas for a batch leg.
