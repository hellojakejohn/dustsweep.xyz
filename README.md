# dustsweep.xyz

Sell every worthless token in your wallet in one signature, on
Robinhood Chain (EVM chain 4663). One signature covers the whole batch;
each token also needs a one-off Permit2 approval the first time you
sweep it.

**Non-custodial. Exact-amount approvals, per transaction. Source is
public. Unaudited.**

That last word is not a formality. This contract interacts with
arbitrary, attacker-controlled ERC20s and has not been reviewed by
anyone but its author and some static analysers. Read it before you use
it. That is the entire point of it being here.

## Why this exists

Two launchpads shipped roughly 63,000 tokens onto this chain and then
turned off their front ends. Noxa halted launches on 11 July 2026 and
lost its domain five days later; Pons V1 disabled launches too. The
tokens still exist and their Uniswap V3 liquidity is still locked and
funded. What is gone is the interface you would use to sell them.

## Layout

```
src/Sweeper.sol        batch entry point, holds no balance,
                       moves only what the Permit2 batch signed for
src/V3Adapter.sol      one token -> WETH via Uniswap V3 SwapRouter02
src/ISweepAdapter.sol  the adapter interface, single source of truth
test/                  Foundry tests, forked against chain 4663
app/                   Vite + React front end
CLAUDE.md              verified chain addresses and the traps
```

## Build

Dependencies are not committed. Install them first:

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
```

## Test

The suite forks mainnet, so it needs a live RPC. `rhc` is defined in
`foundry.toml` and points at the public endpoint, which is rate-limited.

```bash
forge test --fork-url rhc -vv
```

The adapter tests buy their own dust inside the fork rather than
requiring pre-owned tokens. The Sweeper tests fork only to borrow the
live Permit2 so the EIP-712 batch signature path is genuinely exercised.

## Front end

```bash
cd app && npm install && npm run dev
```

Reads balances from the Blockscout API (no key required), quotes every
held token against Uniswap V3 at all three fee tiers, and sorts the
results into four piles: worth sweeping, costs more than it is worth, no
route out, and not dust.

## Status

The contracts are written, tested and not yet deployed. The front end is
read-only: it can price your dust but it cannot send a transaction.
