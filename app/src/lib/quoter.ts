import type { Abi } from 'viem';

/**
 * QuoterV2.quoteExactInputSingle.
 *
 * Two things to know before touching this:
 *
 * 1. The struct field order is NOT the router's. Quoter puts `amountIn`
 *    third, before `fee`. Swapping them silently produces garbage quotes
 *    rather than an error, because both are just numbers on the wire.
 *
 * 2. The real ABI marks this `nonpayable`. It is declared `view` here on
 *    purpose: the function does not write state, it reverts inside the
 *    swap callback and decodes the revert data. Over `eth_call` -- which
 *    is what Multicall3 aggregate3 does -- it works fine. Declaring it
 *    `view` is what lets viem batch it through `multicall`.
 */
export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const satisfies Abi;
