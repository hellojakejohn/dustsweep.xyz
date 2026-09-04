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

## Still needed: one weird one

The checklist asks for a deliberately awkward token, and it is the most
valuable test case you will have. Candidates worth hunting: fee-on-transfer,
rebasing, a `transfer` that returns false instead of reverting, a token
with 0 or 24 decimals, or one whose pool exists but has zero liquidity so
the quote reverts. Ask Claude (this session) to go find one on-chain if you
want it picked for you.
