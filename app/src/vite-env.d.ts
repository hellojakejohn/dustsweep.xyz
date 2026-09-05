/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local fork override for the chain RPC. See src/lib/rpc.ts. */
  readonly VITE_RPC_URL?: string;
  /** Deployed Sweeper address, for a local fork. See src/lib/addresses.ts. */
  readonly VITE_SWEEPER?: string;
  /** Comma-separated token list for a fork run. See src/lib/fixture.ts. */
  readonly VITE_HELD_TOKENS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
