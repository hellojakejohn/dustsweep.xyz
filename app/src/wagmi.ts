import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { robinhoodChain } from './lib/chain';
import { RPC_PUBLIC } from './lib/addresses';

/**
 * Injected connector only. No WalletConnect project id, no Alchemy key,
 * no server. Everything this app does is a read or a signature in the
 * user's own browser.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: {
    [robinhoodChain.id]: http(RPC_PUBLIC, {
      // The public RPC is rate-limited. Coalesce whatever we can.
      batch: { wait: 16 },
      retryCount: 2,
      retryDelay: 250,
    }),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
