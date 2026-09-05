/**
 * Replays the whole sell flow against the anvil fork, headless.
 *
 *   node scripts/run-signer.mjs              # the normal path
 *   PROBE_OFF=1 node scripts/run-signer.mjs  # reproduce the BOW trap
 *
 * Env: FORK_RPC (default http://127.0.0.1:8545) and FORK_PK (default
 * anvil key 0). The Sweeper, adapter and token list come from
 * app/.env.local, exactly as the browser reads them.
 *
 * It boots Vite in middleware mode purely to get `ssrLoadModule`, which
 * is what makes `import.meta.env` and `.env.local` resolve the same way
 * they do in the browser. Running the lib files under plain node instead
 * would need a shim for that, and a shim is a second implementation of
 * the thing under test.
 *
 * Setup is docs/LOCAL-TESTING.md. The states this is meant to produce
 * are steps 9 and 10 of docs/WRITE-HALF-CLICKTHROUGH.md.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

// Relative to this file, not to the cwd, so it runs from anywhere.
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const server = await createServer({
  root: appRoot,
  configFile: join(appRoot, 'vite.config.ts'),
  server: { middlewareMode: true },
  logLevel: 'error',
});

try {
  const mod = await server.ssrLoadModule('/scripts/signer-flow.ts');
  await mod.run();
} catch (e) {
  console.error('HARNESS ERROR:', e?.shortMessage || e?.message || e);
  process.exitCode = 1;
} finally {
  await server.close();
}
