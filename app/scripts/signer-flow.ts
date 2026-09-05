/**
 * The scripted signer: the whole write half, headless, against the fork.
 *
 * Everything here is the app's OWN lib code. The point is not to
 * reimplement the flow, it is to run the exact modules the browser runs
 * with a local key standing in for MetaMask, so a fork pass proves
 * something about the shipped code rather than about a copy of it.
 *
 * What it cannot prove is anything about MetaMask: the rejections, the
 * wrong-chain switch, the approval prompts and the signature UI are all
 * a human's job. See docs/WRITE-HALF-CLICKTHROUGH.md.
 *
 * Run it through scripts/run-signer.mjs, not directly.
 */
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SWEEPER, V3_ADAPTER } from '../src/lib/addresses';
import { isDelegatedCode } from '../src/lib/delegation';
import { isRevertWithoutData } from '../src/lib/errors';
import { fetchFixtureTokens } from '../src/lib/fixture';
import { approvalPlan, approveTx, buildSweepArgs, readAllowances, signSweepPermit } from '../src/lib/permit2';
import { requoteForSweep, DROP_REASON_COPY } from '../src/lib/requote';
import { emptyScan, scanWallet, type ScanState, type ScannedToken } from '../src/lib/scan';
import { defaultSelection } from '../src/lib/selection';
import { parseSweepReceipt, readSweeperConfig, sweeperAbi } from '../src/lib/sweeper';
import { robinhoodChain } from '../src/lib/chain';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';

/**
 * anvil account 0. This key is PUBLISHED: it is in anvil's own startup
 * banner and everybody has it. It is not a secret and never becomes one.
 * Fork only, and never a chain where it holds anything.
 */
const PK = (process.env.FORK_PK ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;

/**
 * The token whose transfer only succeeds to its own pool. Named here so
 * the last line of a run says whether it is still in the wallet, which
 * is the assertion the BOW case actually turns on.
 */
const BOW = '0x9b1C8C5CBC20316Fc311F00a6248b6bCf950ed8a' as Address;

const eth = (v: bigint) => (Number(v) / 1e18).toFixed(7);

export async function run() {
  const account = privateKeyToAccount(PK);
  const chain = { ...robinhoodChain, rpcUrls: { default: { http: [RPC] } } };
  const publicClient = createPublicClient({ chain, transport: http(RPC, { batch: { wait: 16 } }) });
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

  const sweeper = SWEEPER as Address;
  const adapter = V3_ADAPTER as Address;
  console.log(`account   ${account.address}`);
  console.log(`sweeper   ${sweeper}\nadapter   ${adapter}\n`);

  // CHECK 2, the same read useSweep does on connect.
  const code = await publicClient.getCode({ address: account.address });
  const delegated = isDelegatedCode(code);
  console.log(`7702 NOTICE: ${delegated ? 'SHOWN' : 'not shown'} (code ${code ?? '0x'})\n`);

  /* ---- scan, including the will-it-move probe ---- */
  const held = await fetchFixtureTokens(publicClient, account.address);
  let scan: ScanState = { ...emptyScan };
  // PROBE_OFF=1 reproduces the pre-fix behaviour by passing no recipient,
  // which is the same code path as "no Sweeper deployed yet".
  const probeOff = process.env.PROBE_OFF === '1';
  if (probeOff) console.log('*** will-it-move probe DISABLED for this run ***\n');
  await scanWallet({
    client: publicClient,
    owner: account.address,
    held,
    onUpdate: (p) => { scan = { ...scan, ...p }; },
    sweeper: probeOff ? null : sweeper,
  });

  const piles: Record<string, ScannedToken[]> = { sweepable: [], underGas: [], noRoute: [], notDust: [] };
  for (const t of scan.tokens) piles[t.pile].push(t);

  const label: Record<string, string> = {
    sweepable: 'Worth sweeping', underGas: "Costs more than it's worth",
    noRoute: 'No route out', notDust: 'Not dust',
  };
  for (const k of ['sweepable', 'underGas', 'noRoute', 'notDust']) {
    console.log(`${label[k].padEnd(27)}${piles[k].length}  ${piles[k].map((t) => t.symbol).join(', ')}`);
  }
  console.log();
  for (const t of piles.noRoute) {
    console.log(`  No route out: ${t.symbol}  reason=${t.noRouteReason}  quoted=${eth(t.netOutWei)} ETH  selectable=${t.noRouteReason !== 'willNotMove'}`);
  }
  console.log();

  /* ---- selection, approvals, requote, sign, sweep ---- */
  const selectedAddrs = defaultSelection(scan.tokens, scan.gasCostPerLegWei);
  const selected = scan.tokens.filter((t) => selectedAddrs.has(t.address));
  console.log(`pre-ticked ${selected.length}: ${selected.map((t) => t.symbol).join(', ')}\n`);

  const config = await readSweeperConfig(publicClient, sweeper, adapter);
  const allowances = await readAllowances(publicClient, account.address, selected.map((t) => t.address));
  const steps = approvalPlan(
    selected.map((t) => ({ token: t.address, symbol: t.symbol, amount: t.balance })),
    allowances,
  );
  console.log(`${steps.length} approvals, then 1 signature, then 1 sweep`);
  for (const step of steps) {
    const hash = await walletClient.writeContract({ ...approveTx(step.token, step.amount), account, chain });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const rq = await requoteForSweep({
    client: publicClient, owner: account.address, tokens: selected,
    gasCostPerLegWei: scan.gasCostPerLegWei, maxLegValueWei: config.maxLegValueWei,
  });
  for (const d of rq.dropped) console.log(`  dropped ${d.token.symbol}: ${DROP_REASON_COPY[d.reason]}`);
  if (rq.drifted.length) console.log(`  drifted ${rq.drifted.length}`);
  console.log(`legs ${rq.legs.length}\n`);

  const signed = await signSweepPermit(
    walletClient, publicClient, account.address, sweeper,
    rq.legs.map((l) => ({ token: l.token.address, amount: l.amount })),
  );
  const args = buildSweepArgs(
    signed,
    rq.legs.map((l) => ({ token: l.token.address, adapter, minOut: l.minOut, data: l.data })),
  );

  try {
    await publicClient.simulateContract({ address: sweeper, abi: sweeperAbi, functionName: 'sweep', args, account });
  } catch (err) {
    const bare = isRevertWithoutData(err);
    console.log(`SWEEP SIMULATE reverted. delegated=${delegated} isRevertWithoutData=${bare}`);
    if (delegated && bare) {
      console.log('ERROR CARD: the 7702 hint, not the generic copy.');
      return;
    }
    console.log(`ERROR CARD: generic copy -> ${(err as any).shortMessage}`);
    return;
  }

  const before = await publicClient.getBalance({ address: account.address });
  const hash = await walletClient.writeContract({ address: sweeper, abi: sweeperAbi, functionName: 'sweep', args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const parsed = parseSweepReceipt(receipt, sweeper)!;
  const after = await publicClient.getBalance({ address: account.address });

  console.log('--- RECEIPT ---');
  console.log(`RECEIPT: ${parsed.legsFilled} of ${parsed.legsAttempted} sold, landed ${eth(parsed.userOutWei)} ETH`);
  console.log(`gross ${eth(parsed.grossWei)}  fee ${eth(parsed.feeWei)}  gas ${eth(parsed.gasUsedWei)}`);
  console.log(`wallet ETH delta ${eth(after - before)} (net of gas)`);
  for (const f of parsed.failed) console.log(`FAILED ${f.token} -> ${f.reason} returned=${f.returned}`);
  console.log(`BOW still held: ${await publicClient.readContract({ address: BOW, abi: [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}] as const, functionName: 'balanceOf', args: [account.address] })}`);
}
