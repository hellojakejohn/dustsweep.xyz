# The Noxa finding

**Verified on-chain 4 Sep 2026. This changes what dustsweep is for.**

---

## One paragraph

Noxa was Robinhood Chain's biggest launchpad. It halted launches on
11 July 2026, went dark, and lost its domain on 16 July. It deployed
roughly 60,000 tokens, about 75% of everything ever launched on the chain.
Its factory is at `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` and it is
**interface-identical to Pons V1**: same event topic hashes, same function
set, same architecture, same Uniswap V3 config, same SwapRouter02, same 1%
fee tier, WETH-paired. Its pools are still live and still hold WETH,
because the liquidity positions were permanently locked. There is no
launchpad UI left to sell through.

**The V3Adapter you are building tonight is the exit for the single
largest stranded pile on this chain, and it needs zero extra code to
support it.**

---

## What was verified

| Claim | Method | Result |
|---|---|---|
| Factory identity | Traced CASHCAT's creation | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`, 22,811 bytes, unverified source |
| Same architecture as Pons V1 | Selector + event topic extraction | **Identical**. `TokenDeployed` and `TokenLaunched` share the exact same topic0 hashes as Pons V1 |
| Uses the same router | `getDexConfig(0)` | factory `0x1f7d7550…`, positionManager `0x73991a25…`, **swapRouter `0xcaf681a6…`**, poolFee 10000, tickSpacing 200 |
| WETH-paired | 50 sampled `TokenLaunched` events | **50 of 50** |
| Launches halted | `LaunchEnabledUpdated` + latest tx | Most recent `launchToken` call was 3 Sep 2026 and **reverted**. Contract live, launches off. |
| Pools still funded | `WETH.balanceOf(pool)` | 0.047 to 0.585 WETH on sampled dead tokens; 1,023 WETH on CASHCAT |
| Quotes still return | QuoterV2 on 6 dead tokens | All returned. 0.00143 to 0.00274 ETH per 0.1% of supply |
| Size of the pile | Chunked `eth_getLogs` on `TokenDeployed` | **27,316 directly counted**, densest window only partly scanned, extrapolates to **~63,000** |

The extrapolation independently corroborates the reported "over 60,000"
figure, which came from press coverage rather than the chain.

## Why the count is an estimate and not exact

The public RPC rate-limits and times out on dense log ranges. 27,316 is a
hard floor from ranges that returned cleanly. The peak window
(blocks ~4.86M to ~8.06M) has ~2.6M blocks unscanned at an observed density
of ~2,079 deployments per 150k blocks, which is where the remaining ~36,000
comes from. Re-run the scan against Alchemy with a real key to get an exact
number before putting it on the landing page as a hard figure.

Deployments are concentrated between block 61,688 and ~8,061,691. Zero
`TokenDeployed` events after block 8,061,692, consistent with the 11 July
halt.

---

## What this changes

**1. The V3Adapter is no longer a Pons V1 adapter. It is a Noxa + Pons V1
adapter, and Noxa is the bigger half by roughly 400x.**

Pons V1 sampled at 148 launches. Noxa is ~63,000. Both are handled by the
same code path because their dex configs are byte-identical. Nothing extra
to write. Just do not hardcode a single factory address when detecting
sweepable tokens, index both.

**2. The curve adapter matters much less than the checklist implies.**

It was already item 5 on the cut list. It should stay there. Pons V2 curve
dust is a minority of the chain, most of it does not redeem to ETH, and
its real recoverable value is frequently zero (see below). Noxa dust is
plain Uniswap V3 and is the actual product.

**3. The launch story writes itself, and it is better than the one in the
checklist.**

The current plan leads with "124,016 launched, 1,362 made it." The stronger
version is that the chain's biggest launchpad collected roughly $12M in
fees, halted launches, went dark, and lost its domain, leaving ~63,000
tokens with locked liquidity and no front end to sell them through.
dustsweep is the exit. That is a specific, verifiable, sympathetic story
about a real event, and it does not require anyone to care about
bonding-curve mechanics.

Do not overclaim it. Noxa's liquidity is locked and the pools work fine.
The tokens were never bricked. What is gone is the interface. Say that.

---

## Economics of the Noxa pile, measured

Sampled dead tokens hold 0.047 to 0.585 WETH in their pools. Initial dev
buys on those launches ran 0.03 to 0.25 ETH. So a typical never-traded
Noxa token has a few hundred dollars of extractable WETH total, spread
across everyone who ever bought it.

At 1.23 gwei, a ten-token batch sweep costs ~0.00148 ETH. A holder with
0.1% of a token's supply gets ~0.0015 to 0.0027 ETH per token. **So a
ten-token sweep is roughly break-even to modestly profitable.** The three
pile sort is what keeps this honest. Do not cut it.

CASHCAT is the exception, not the model: 1,023 WETH in its 1% pool, 826 in
its 0.3% pool. Which raises the next point.

---

## Build note that came out of this

**CASHCAT has pools at three fee tiers (10000, 3000 and 500), not one.**
Pons V1 and Noxa both *launch* at 10000, but anyone can open a pool at any
tier afterwards, and for tokens that actually traded, the best route may
not be the launch tier. The 0.3% pool holds 826 WETH against the 1% pool's
1,023.

So: probe 10000 first because that is where the launch liquidity is, but
**quote all three tiers and take the best**. It is three QuoterV2 calls
instead of one and it is the difference between a correct quote and
leaving money on the table on exactly the tokens worth the most.
