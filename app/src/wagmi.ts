import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { robinhoodChain } from './lib/chain';
import { RPC_URL } from './lib/rpc';

/**
 * The WalletConnect project id is NOT a secret and must not go in .env.
 * It is designed to ship inside the client bundle -- every WalletConnect
 * site exposes one, and it is scoped by the domain allowlist in the
 * WalletConnect dashboard rather than by being hidden.
 *
 * This is the exact opposite of RHC_RPC_URL, the Alchemy key, which is
 * Foundry-only and must never appear anywhere under app/. Vite inlines
 * every VITE_* value into the static bundle and this repo is public.
 * Do not "tidy" this one into an env var and do not move that one here.
 */
const WALLETCONNECT_PROJECT_ID = '0544e406756d765975900cd503753a8f';

/**
 * Two connectors, and the second one exists because of a real bug.
 *
 * `injected` is a browser extension, or the in-app browser inside a
 * wallet app. It was the only connector until 4 Sep, which is why the
 * site was a dead end in mobile Safari and Brave: MetaMask on a phone is
 * a separate application and injects nothing into other browsers. The
 * picker correctly found no wallet and showed "No wallet detected" to
 * people with a wallet open in the next app over.
 *
 * `walletConnect` covers that: it pairs the page with a wallet app over a
 * relay, by QR code on desktop and by deep link on mobile.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    injected(),
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: 'dustsweep',
        description: 'Sell every worthless token in your wallet, on Robinhood Chain.',
        url: 'https://dustsweep.xyz',
        icons: ['https://dustsweep.xyz/janitor-mark.png'],
      },
    }),
  ],
  transports: {
    [robinhoodChain.id]: http(RPC_URL, {
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
