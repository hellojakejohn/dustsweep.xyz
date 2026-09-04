# dustsweep.xyz

Batched dust sweeper on Robinhood Chain (EVM chain 4663). Connect wallet,
see every worthless token you hold, sell them all in one transaction.
$SWEEP is the companion token on the Pons launchpad.

Solo project. Jake is the only builder. Ship fast, but the security items
below are not negotiable.

---

## READ THIS BEFORE WRITING ANY CHAIN CODE

This chain launched 1 July 2026. **Almost everything a model "knows" about
it is wrong or invented.** Every address and signature below was verified
directly on mainnet on 4 Sep 2026 by reading contract code and calling the
chain, not by reading docs.

**Do not substitute an address from memory. Do not "correct" one of these.
If something here seems wrong, verify on-chain and tell Jake, do not
silently change it.**

Anything not listed here is unverified. Say so rather than guessing.

---

## Verified addresses

Chain ID 4663. Public RPC `https://rpc.mainnet.chain.robinhood.com`
(rate-limited, fine for reads from a browser or curl, **blocked for
Foundry by Cloudflare** -- see "The public RPC blocks Foundry" below.
Use Alchemy).
Explorer `https://robinhoodchain.blockscout.com`.

```
WETH            0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73  18 dec, aeWETH proxy
USDG            0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  6 dec
UniswapV3Factory 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA
SwapRouter02    0xCaf681a66D020601342297493863E78C959E5cb2  <-- use this
QuoterV2        0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7
Permit2         0x000000000022D473030F116dDEE9F6B43aC78BA3  canonical
Multicall3      0xcA11bde05977b3631167028862bE2a173976CA11

NOXA factory    0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB  <-- biggest dust source
Pons V1 factory 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB
Pons V2 factory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
```

SwapRouter02 was confirmed three independent ways: Uniswap's official
deployments page for 4663, on-chain self-report (`factory()` and `WETH9()`
both cross-reference correctly), and Noxa's and Pons V1's own live
`getDexConfig(0)` which both return it as their production router.

### Never route v3 swaps through UniversalRouter

`0x8876789976dEcBfCbBbe364623C63652db8C0904` is a Robinhood-modified fork.
Its v4 swap struct carries an extra `minHopPriceX36` field and stock
Uniswap SDK calldata reverts against it. **It is a v4 contract and this
project does not use it.** Route v3 through SwapRouter02 only.

---

## Six traps that will burn you

**1. Do not filter tokens by address suffix.**
A Pons README claims every launched token ends in hex `bbbb`. It is false.
0 of 134 sampled Pons V2 tokens end in `bbbb` or `dddd`. 1 of 123 Pons V1
tokens does, and that deployer mined it with a custom salt. Filtering on
suffix would miss ~99% of tokens. Identify tokens by indexing factory logs
or calling `getLaunchedToken(token)`.

**2. Noxa is the main target, not Pons.**
Noxa halted launches 11 July 2026 and its front end is gone. ~63,000
tokens (27,316 directly counted, dense window partly unscanned), roughly
75% of all deployments on the chain. Its factory is interface-identical to
Pons V1: same `TokenDeployed` / `TokenLaunched` topic0 hashes, same
`getDexConfig` shape, same router, same 1% tier, WETH-paired. **One code
path handles both. Index both factories, hardcode neither.**

Shared event topics:
```
TokenDeployed 0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a
TokenLaunched 0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a
```

**3. Quote all three fee tiers, not just 1%.**
Noxa and Pons V1 both launch WETH-paired at fee 10000. But pools can be
opened at other tiers afterwards. CASHCAT holds 1,023 WETH at 10000 and
827 WETH at 3000. Quote 10000, 3000 and 500 and take the best. Probe 10000
first, it is where launch liquidity lives.

**4. A Pons V2 curve token's displayed value must be capped at
`realQuoteReserve`.**
The curve prices against `quoteReserve`, but only `realQuoteReserve` is
actually withdrawable. The difference is `phantomQuote`, which is virtual
liquidity used to set the opening price. Measured on live curves:
`phantomQuote` 267e18 against a real reserve of **1 wei**; another 421e18
against **zero**. Showing notional value without the cap would quote users
money the contract cannot pay. For a tool whose entire pitch is honesty
this is the bug that ends the project.

**5. Most Pons V2 dust does not redeem to ETH.**
Of 134 sampled V2 launches: 29% quote in GLD (tokenized gold), 28% USDG,
**only 7.5% native ETH**, the rest tokenized equities (NFLX, NU, IBM, AMD,
DJT, BULL). Branch on the curve's `isNativeQuote()`. Never assume ETH out.
This only affects the curve path. Noxa and Pons V1 are 100% WETH.

**6. Use timestamps, not block numbers, for deadlines.**
Average block time is 101 ms. A block-number deadline is a couple of
seconds of slack, not minutes.

---

## Pons V2 bonding curve

Every V2 curve is deployed with identical bytecode (10,229 bytes, not a
proxy), so one ABI fits all. Source is not verified on the explorer, so
these came from dispatcher selector extraction plus an empirical check
against a real on-chain sell.

```solidity
// 0xd04c6983 -- argument order confirmed against a real sell tx
function sell(uint256 tokenAmountIn, uint256 minQuoteOut, address recipient) external;
// 0x59a87bc1
function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) external payable;
```

Reads: `getReserves()` `tokenReserve()` `quoteReserve()` `realQuoteReserve()`
`phantomQuote()` `sellableTokens()` `graduated()` `readyToGraduate()`
`isNativeQuote()` `pairToken()` `token()` `feeBps()` `creatorTaxBps()`
`graduationThreshold()` `currentSnipeTaxBps(address)`
`maxInternalPriceImpactBps()`.

Measured: `feeBps` 100 (1%), `creatorTaxBps` 0 to 200,
`maxInternalPriceImpactBps` **300 (3%)** so a single large sell can revert
on price impact. Check `graduated()` before touching a curve, and get the
curve address from the `TokenLaunched` event or
`factory.getLaunchedToken(token)`. Never hardcode a per-token address.

Graduation thresholds are denominated in the pair token and vary widely
(130 NFLX, 667 NU, 43 IBM, 1054 BULL). Never hardcode 4.2 ETH.

---

## Architecture

### Contracts

- `Sweeper.sol` -- entry point. Holds no balance, whitelisted adapters
  only, Permit2 batch is the authoritative list of movable tokens.
  **Written. Not yet deployed.**
- `V3Adapter.sol` -- token to WETH via SwapRouter02, enforces `minOut`,
  sends WETH straight back to the caller, ownerless and immutable.
  Covers Noxa + Pons V1 + graduated V2. **Written, 12/12 fork tests pass
  against real mainnet state. Not deployed.**
- Curve adapter -- later. Explicitly on the cut list.

**`ISweepAdapter` approves, it does not transfer.** The code path in
`Sweeper.sweep` is `forceApprove(adapter, received)` then
`adapter.sell(...)`, so an adapter must pull with `transferFrom`. The
doc comment in `Sweeper.sol` now says this correctly; the note that it
said "funded with" is out of date as of 4 Sep 2026.
Note the payout leg is inconsistent with this: it does
`WETH.safeTransfer(payoutAdapter, net)` first, so a payout adapter is
genuinely pre-funded. Do not write one adapter that assumes both.

`ISweepAdapter` is declared twice, in `Sweeper.sol` and `V3Adapter.sol`.
The two signatures currently match. They are not linked by the compiler,
so nothing stops them drifting. Aderyn flags this as its only High.

### Front end -- decided: Vite + React + wagmi/viem + Tailwind

**Read half is built and running in `app/`. See `app/README.md`.**
One centred card, four collapsible sections, nothing pre-checked.
Verified against two real mainnet wallets on 4 Sep 2026: a 184-token
wallet sorted 29 sweepable / 17 under gas / 123 no route / 13 not dust,
552 quote calls in ~18s on the public RPC without rate limiting.

**Trap 7: not everything in a wallet is dust.** Quoting alone put
CBBTC, SPY, NVDA, AAPL, GME, TSLA, HIMS and SPCX in the sweepable pile.
`maxLegValueWei` does not save us -- at 5 ETH it catches the wrapped
Bitcoin and misses every stock. The front end now holds back any holding
quoting above `NOT_DUST_CEILING_WEI` (0.1 ETH) plus anything whose
on-chain `name()` ends in `• Robinhood Token` (U+2022, verified
on-chain). Match on name: this chain has two different tokens with
symbol `PLTR`, one real and one a meme, and an `IBM` called "I BUY
MEMES". The real fix is provenance -- index `TokenDeployed` from both
factories and treat only those addresses as dust -- and is not done.

**The ceiling is per holding, not per token.** At 0.1 ETH the test
wallet's 0.0004 CBBTC (0.011 ETH of wrapped Bitcoin) falls below the
line and lands in sweepable. That is the ceiling working as specified,
but it means the value backstop does not catch small positions in real
assets. Only provenance will.

**Wallet connectors: `injected` + `walletConnect`.** Injected alone made
the site a dead end in mobile Safari and Brave, because MetaMask on a
phone is a separate app that injects nothing into other browsers. The
picker correctly found nothing and showed "No wallet detected" to people
with a wallet open in the next app over.

The WalletConnect project id is public by design and lives in `wagmi.ts`,
NOT in `.env`. It ships in the bundle like every WalletConnect site's
does, and is scoped by the domain allowlist in the WalletConnect
dashboard. Do not "tidy" it into an env var, and never move `RHC_RPC_URL`
the other way.

**Bundle cost, measured 4 Sep. Read the right number.** Total emitted
assets went 0.53 MB -> 3.10 MB, which looks alarming and is the wrong
figure to judge by. `showQrModal: true` pulls in Reown AppKit: the modal,
52 Phosphor icon chunks (159 KB), and a 1 MB brotli WASM blob. All of it
is code-split and lazily fetched.

What actually loads on first paint went **560 KB -> 592 KB, about 6%**.
The AppKit payload (~2.3 MB raw) is fetched only when someone taps
connect AND picks WalletConnect. Desktop users with an extension never
fetch it at all.

That connect-time cost is real on cellular and could be removed with
`showQrModal: false` plus a hand-rolled QR and deep-link path. That means
reimplementing AppKit on the single most important path in the app, so it
is deliberately not done. Do not re-panic at the 3.10 MB figure without
re-reading which chunks `dist/index.html` actually preloads.

Not Next.js. This app has no server-side work: wallet connect, reads,
signing and sending all happen in the browser, and the one reason to want
a backend (hiding an API key) went away when Blockscout turned out to
need no key. App Router plus wagmi also drags in `"use client"` sprawl and
hydration mismatches on wallet state, which is a bad thing to be debugging
late at night. Vite builds to a static `dist/` that deploys anywhere.

Keep app logic in plain React components with no framework coupling. If
dynamic OG images for the share card later become the growth engine,
that is the one real argument for Next, and a small uncoupled app moves
in a couple of hours.

### The seam: build the read half first

The front end splits cleanly, and the read half needs no contract at all.

**Read half (unblocked now, no contract needed):** wallet connect, balance
scan, quote every held token through QuoterV2, three-pile sort
(sweepable / under gas / no route), landing page.

**Write half (needs the deployed Sweeper address + ABI):** Permit2 batch
signature, the sweep transaction, receipt and share card.

Build the read half completely first. It is roughly 70% of the work and
you can load the site and watch real dust get sorted before a single
contract is deployed.

### Finding a user's dust

**Blockscout, no API key required. Verified working.**

```
GET https://robinhoodchain.blockscout.com/api/v2/addresses/{address}/token-balances
```

Returns an array of `{ value, token: { address_hash, symbol, decimals, type } }`.
Filter to `type === "ERC-20"`. Tested against a real wallet holding real
dust: 21 tokens back, correct symbols and decimals.

Alchemy's `alchemy_getTokenBalances` is the alternative and supports 4663,
but **it has never been tested with our key**, so do not put it on the
critical path. Blockscout first, Alchemy later as an optimisation if rate
limits bite.

### Quoting

QuoterV2 `quoteExactInputSingle` takes a struct in a different field order
than the router's:

```solidity
struct QuoteExactInputSingleParams {
    address tokenIn; address tokenOut; uint256 amountIn;
    uint24 fee; uint160 sqrtPriceLimitX96;
}
```

It is `nonpayable` in the ABI but works fine over `eth_call`. Quote all
three fee tiers (10000, 3000, 500) and take the best, then pass the
winning tier to the adapter as `abi.encode(uint24 fee)` in `Leg.data`.
Empty `data` means the 1% default.

**A token that quotes to zero goes in the "no route" pile and must never
reach the adapter.** `V3Adapter` reverts on `minOut == 0` by design,
because an off-chain quote with no on-chain slippage bound is a sandwich
waiting to happen.

`unwrapWETH9` works: the aeWETH implementation
(`0xc6b81b429797e0f555440b70cd99e032d7ae947e`) exposes standard
`withdraw(uint256)` and `deposit()`. Still fork-test the unwrap leg.

Permit2 batch transfer selector is `0xedd9444b`
(`permitTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes)`).
That is the one-signature-many-tokens call the sweeper depends on.

---

## Foundry config trap

**Never put `chain = 4663` in the `[etherscan]` block of `foundry.toml`.**
Foundry validates that field against its own chain list, 4663 is not in
it, and its presence makes EVERY forge command fail with
`Error: Chain 4663 not supported` -- including `forge test`, which has
nothing to do with verification. This cost a full session's fork run
before it was spotted. Verify with explicit flags instead:

```
forge verify-contract <addr> src/V3Adapter.sol:V3Adapter \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api --rpc-url rhc
```

---

### The public RPC blocks Foundry (Cloudflare)

`forge test --fork-url rhc` and `anvil --fork-url rhc` fail against
`https://rpc.mainnet.chain.robinhood.com`. The endpoint returns a
Cloudflare bot-challenge page instead of JSON. It is not an outage and it
is not the test code: the same endpoint, hit from a browser in the same
minute, returned `{"jsonrpc":"2.0","id":1,"result":"0x3413dbc"}` with no
challenge. Cloudflare is fingerprinting the client and Foundry's HTTP
stack fails the check.

**Consequence: an Alchemy key for 4663 is on the critical path**, not a
nice-to-have. It blocks the fork tests and the local anvil plan equally.

**RESOLVED 4 Sep.** `[rpc_endpoints] rhc` now points at `${RHC_RPC_URL}`,
set in `.env` at the repo root and gitignored. `rhc_public` keeps the
public URL for cast reads and Blockscout verification, neither of which
forks. `.env.example` documents the variable. The key is Foundry-only and
must never appear under `app/`: Vite inlines `VITE_*` into the static
bundle and this repo is public.

**Fork tests are not pinned to a block.** Two runs minutes apart returned
different CASHCAT figures on identical input (97.998e18, then 98.141e18)
because the pool is live and the fork follows head. The Noxa numbers were
byte-identical across both runs, so that pool is quiet. The risk is a red
test that has nothing to do with the code: `test_FeeTiersCanDisagree`
asserts the 1% and 0.3% tiers disagree, and an arbitrageur closing that
gap breaks it. Undecided whether to pin.

Until there is a key, run only the suites that do not fork:

```
forge test --match-path "test/BurnAdapter.t.sol" -vv
```

With a key:

```
forge test --fork-url $ALCHEMY_URL
anvil --fork-url $ALCHEMY_URL
```

---

## Economics, measured 4 Sep 2026

Gas ~1.23 gwei (live reads later the same day came back 0.92 to 0.97
gwei, so read it, never hardcode it). One swap leg (~180k gas) costs ~0.000222 ETH. A ten-token
batch (~1.2M gas) costs ~0.00148 ETH.

A never-traded Noxa or Pons V1 pool holds 0.02 to 0.6 WETH total across
all holders. A holder with 0.1% of supply gets ~0.0014 to 0.0027 ETH.
**So a ten-token sweep is roughly break-even to modestly profitable.**
The three-pile sort is what makes this honest instead of value-destroying.
Do not cut it.

---

## Non-negotiable

1. **Never claim the contract is safe.** It is unaudited and interacts
   with arbitrary hostile ERC20s. The honest framing is: non-custodial,
   exact-amount approvals, public source, unaudited. That is a better
   pitch than a safety claim.
2. **These never get cut for schedule:** fork tests against real dead
   tokens, `slither .`, `aderyn .`, sweeping Jake's own wallet first, the
   receipt/share card, the unaudited disclosure.
3. Set `maxLegValueWei` LOW for launch. 0.5 ETH, not 5.
4. Test the batch with a deliberately broken token in it. The try/catch
   path is the one that matters and the one nobody tests.
5. Test with a token NOT in the permit. It must be untouched.

---

## Working style

Peer level, no 101 explanations. No em-dashes, use double hyphens.
Concise and action-oriented. Show the code change, not a wall of prose
around it. Ask one clarifying question rather than guessing. Push back
when Jake is wrong. Honest uncertainty beats confident BS.

If the same error class repeats after 2+ fixes, or you are guessing
between options, stop and investigate properly instead of iterating.
If Jake pushes back on a conclusion, treat it as a signal you may be
anchored on a wrong assumption, especially the assumption that the
current tool, repo or approach is the right one at all.

---

## Contract status as of 4 Sep, end of day

**27/27 tests pass**, first observed green on a working fork RPC, 4 Sep.

| Suite | Tests | Forks? | Mutation-verified? |
|---|---|---|---|
| `Sweeper.t.sol` | 8 | no, mocks | yes |
| `BurnAdapter.t.sol` | 7 | no, mocks | no |
| `V3Adapter.t.sol` | 12 | yes, live mainnet state | no |

An earlier version of this file said **"20/20 tests pass"** and attributed
it to the Sweeper. That was wrong twice. `Sweeper.t.sol` has 8 tests, and
20 was 8 + 12: a count of test functions that existed, not of tests
observed passing. When it was written those 12 V3Adapter tests had never
executed once. Corrected after the first real fork run.

The mutation testing covers the 8 Sweeper tests only. The contract was
broken three ways (catch branch not returning the token, leg/permit
equality check removed, value ceiling removed) and each test went red,
then the source was restored byte-identical. A green tick that has never
been seen to fail is not evidence. Neither is a count of tests nobody
has run.

Already done, do not re-report these:

- `maxLegValueWei` is **0.5 ether**, not 5.
- `feeSink` has a zero-address guard in the constructor and the setter.
- All four admin setters emit events.
- `ISweepAdapter` lives in `src/ISweepAdapter.sol` only. Zero local copies.
- aeWETH `deposit`/`withdraw` was probed live and round-trips exactly.

### Two contracts added late on day 1

**`src/BurnAdapter.sol`** -- sends a token to
`0x000000000000000000000000000000000000dEaD` and returns 0. For dust with
no route out, which is most of it. **7/7 tests pass**, no fork needed.

The property that makes the two adapters non-interchangeable:
**`BurnAdapter` requires `minOut == 0` and `V3Adapter` requires
`minOut != 0`.** A UI bug that routes a sellable token to the burner, or
a burnable one to the router, reverts instead of destroying value. Do not
relax either check.

It burns to `dEaD`, not `address(0)`, because many ERC20s revert on a
transfer to zero.

**`src/BuybackBurner.sol`** -- buys SWEEP with the fee sink's ETH and
sends it straight to `dEaD`. **Untested and untestable today: no SWEEP
pool exists.** It is written, it compiles, it has never run.

Its trust properties are deliberate and should be stated publicly: no
owner, no withdraw function, SWEEP address immutable, the swap recipient
is the graveyard so proceeds never touch a wallet even transiently,
anyone can call `burn()`, 1-hour cooldown, requires `minOut != 0`.

### What the owner can and cannot do (state this accurately)

`BuybackBurner` genuinely cannot be rugged. **`Sweeper` is
owner-controlled and must not be described as trustless.** The owner can
whitelist adapters, change fees up to the 5% cap, redirect the fee sink,
raise the value ceiling, and set the payout target.

What bounds it: the Sweeper holds no custody, so there is no treasury to
drain. The worst case from a compromised owner key is tokens stolen in
flight during subsequent sweeps, not a balance sitting there waiting.

Honest framing: the burner cannot be rugged, the sweeper is
owner-controlled with capped fees and no custody, and here is the key
that controls it. Hardware wallet for the owner key. If volume shows up,
put a timelock on `setAdapter`.

### The payout path is unreachable at launch

`payoutToken` and `payoutAdapter` default to `address(0)` and `setPayout`
has not been called, so `wantPayout = true` reverts `PayoutUnavailable`.
That is why it has no test coverage yet and why that is acceptable for now.

**The front end must not offer a "pay me in SWEEP" toggle until SWEEP
exists and `setPayout` has been called.** A toggle that always reverts is
worse than no toggle.

When SWEEP does land, that path needs tests before it goes live. It uses
the pre-funded `safeTransfer`-then-`sell` convention rather than the
approve-then-pull one every other leg uses, which is the single most
likely place for a wrong-convention adapter bug.

### Known gaps, ranked

1. `wantPayout = true` untested. Blocks the SWEEP payout, not the sweep.
2. No fee-on-transfer token in the Sweeper batch suite. Both contracts
   have comments claiming they handle it; nothing proves it at batch level.
3. Duplicate token in one permit is unasserted. Traced, no loss vector
   (the second leg finds a zero balance and skips).
4. The unwrap leg runs against MockWETH, not live aeWETH.

None of these block a read-only launch, because the contract is not part
of a read-only launch.
