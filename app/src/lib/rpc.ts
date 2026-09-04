import { RPC_PUBLIC } from './addresses';

/**
 * The one RPC URL the app uses: every read goes through it, and it is the
 * URL a wallet is asked to add the chain with, so the wallet and the app
 * are never pointed at two different nodes.
 *
 * Override it for a local anvil fork:
 *
 *   VITE_RPC_URL=http://127.0.0.1:8545 npm run dev
 *
 * Unset -- the normal case, and every production build -- this is the
 * public RPC and nothing changes. An empty value counts as unset.
 *
 * When it IS set the header says so out loud. Demoing a forked chain that
 * looks exactly like the real one is the accident this exists to prevent.
 */
const override = import.meta.env.VITE_RPC_URL?.trim();

export const RPC_URL = override || RPC_PUBLIC;

export const RPC_IS_OVERRIDDEN = RPC_URL !== RPC_PUBLIC;
