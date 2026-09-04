import { defineChain } from 'viem';
import { CHAIN_ID, EXPLORER, RPC_PUBLIC, UNISWAP_V3 } from './addresses';

/**
 * Robinhood Chain. Not in viem's chain list, so we define it here.
 * Every value below is from CLAUDE.md and was verified on-chain.
 *
 * Multicall3 is the canonical deployment and its bytecode was confirmed
 * present at this address on 4663. viem uses it to batch our quote reads.
 */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_PUBLIC] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: EXPLORER },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
});

export const QUOTER_V2 = UNISWAP_V3.quoterV2;

export function explorerToken(address: string) {
  return `${EXPLORER}/token/${address}`;
}
