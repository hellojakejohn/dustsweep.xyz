/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local fork override for the chain RPC. See src/lib/rpc.ts. */
  readonly VITE_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
