# Claude Code task: front end, read half

Read `CLAUDE.md` first. Every address in it is verified on-chain. Do not
substitute an address from memory and do not "correct" one. If something
looks wrong, verify it on-chain and say so instead of changing it.

## Scope

Build ONLY the read half. It touches no contract, so it is fully
unblocked. Do not build the sweep transaction, the Permit2 signature, or
the receipt yet. Those need a deployed address that does not exist.

In scope:

1. Landing page.
2. Wallet connect (chain 4663).
3. Scan the connected wallet for every ERC-20 it holds.
4. Quote each one.
5. Sort into three piles: sweepable, under gas, no route.
6. An empty state and a loading state that do not look broken.

## Stack

Vite + React + wagmi + viem + Tailwind. Not Next.js, the reasoning is in
CLAUDE.md. Keep components free of framework coupling so a later move is
cheap. No server, no API routes, no API keys.

## Finding the user's tokens

Blockscout. No key needed, already verified working:

```
GET https://robinhoodchain.blockscout.com/api/v2/addresses/{address}/token-balances
```

Returns `[{ value, token: { address_hash, symbol, decimals, type } }]`.
Keep only `type === "ERC-20"`. Skip WETH and USDG, they are not dust.

Do not use Alchemy. It supports this chain but has never been tested with
our key, so it is not going on the critical path tonight.

## Quoting

QuoterV2 at `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`, method
`quoteExactInputSingle`. Note the struct field order differs from the
router's:

```
(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)
```

It is marked nonpayable but works fine over `eth_call` / viem's
`simulateContract`.

Quote each token at all three fee tiers (10000, 3000, 500) against WETH
and keep the best. Most dust only has a 10000 pool and the other two will
revert. That is expected, not an error. Catch and move on.

Batch these reads through Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11`. The public RPC is
rate-limited and a wallet with 40 tokens means 120 quote calls.

## The three piles, and why this is the important part

- **Sweepable** — quote returns, and the value clears the gas cost.
- **Under gas** — quote returns, but it is worth less than it costs to
  sell. Show the number honestly. Do not hide these.
- **No route** — no pool, or the quote reverts, or it rounds to zero.

Gas maths: about 1.23 gwei on this chain, roughly 180k gas per token
sold, so about 0.000222 ETH per token. Read gas live, do not hardcode it.

**This sort is the product.** The tool's whole pitch is being the honest
one. A tool that tells someone a token is worth sweeping when it is not
has destroyed the only thing it had. When in doubt, put a token in the
worse pile and let the user overrule it.

## Do not

- Do not filter tokens by address suffix. A Pons README claims tokens end
  in `bbbb`. It is false and it would miss ~99% of them.
- Do not assume one fee tier.
- Do not claim anything is safe or audited anywhere in the UI.
- Do not add localStorage-backed caching yet. Correctness first.

## Definition of done

Connect a wallet, see real tokens sorted into three piles with real
numbers, on a page that does not look like a default template. No
contract deployed, no transaction ever sent.
