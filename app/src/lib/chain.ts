import { defineChain } from 'viem';
import { CHAIN_ID, EXPLORER, UNISWAP_V3 } from './addresses';
import { RPC_URL } from './rpc';

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
  // Also what `switchChain` hands the wallet when the chain is not in it
  // yet, which is why it follows the local-fork override too.
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: EXPLORER },
  },
  contracts: {
    multicall3: { address: MULTICALL3 },
  },
});

/**
 * Enough chain names to greet a first-time visitor by the network they
 * actually arrived on. Phantom users land here on Ethereum or Solana;
 * "you are on chain 1" is plumbing leaking into the copy.
 *
 * Deliberately a hand-written map. viem ships every chain it knows, but
 * importing that registry to render one label would cost more bundle
 * than the whole picker.
 */
const KNOWN_CHAINS: Record<number, string> = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Smart Chain',
  100: 'Gnosis',
  130: 'Unichain',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche',
  59144: 'Linea',
  81457: 'Blast',
  534352: 'Scroll',
  11155111: 'Sepolia',
};

/** Falls back to the number only when we genuinely have no name for it. */
export function chainName(id: number | undefined): string {
  if (id === undefined) return 'another network';
  if (id === robinhoodChain.id) return robinhoodChain.name;
  return KNOWN_CHAINS[id] ?? `network ${id}`;
}

export const QUOTER_V2 = UNISWAP_V3.quoterV2;

export function explorerToken(address: string) {
  return `${EXPLORER}/token/${address}`;
}
