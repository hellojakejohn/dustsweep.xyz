import { useCallback, useRef, useState } from 'react';
import { erc20Abi, type Address, type Hex } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { CHAIN_ID, requireBurnAdapter, requireSweeper } from '../lib/addresses';
import { ignite } from '../lib/burn';
import { recordLocalSweep } from '../lib/feed';
import { robinhoodChain } from '../lib/chain';
import { DELEGATED_REVERT_HINT, isDelegatedCode } from '../lib/delegation';
import { isRevertWithoutData, isUserRejection, readableError } from '../lib/errors';
import {
  approvalPlan,
  approveTx,
  buildSweepArgs,
  readAllowances,
  signSweepPermit,
  type ApprovalStep,
  type Leg,
} from '../lib/permit2';
import type { ScannedToken } from '../lib/scan';
import { parseSweepReceipt, readSweeperConfig, sweeperAbi, type SweepReceipt } from '../lib/sweeper';

/**
 * The burn half. Destroying a dead token, for the roughly two thirds of
 * a wallet that has no buyer at any price.
 *
 * WHY THIS IS A SEPARATE HOOK AND A SEPARATE TRANSACTION.
 *
 * `BurnAdapter.sol`'s own header says it: burning cannot be undone, so
 * the UI must confirm it separately from a sweep, with its own wording
 * and its own button. Mixing burn legs into a sell batch would put one
 * signature across two intents, one of which is irreversible, and that
 * is precisely the failure the contracts already guard against at their
 * own level (V3Adapter requires `minOut != 0`, BurnAdapter requires
 * `minOut == 0`, so a leg built to sell can never be routed into a burn).
 * Reproducing that separation in the UI costs one extra signature. Worth
 * it.
 *
 * It is also much simpler than selling, which is the other reason not to
 * thread it through `useSweep`: there is no quote, so no requote, no
 * drift gate, no slippage and no minOut. The stages are approvals, one
 * signature, one transaction.
 *
 * What it shares with the sell path is everything that touches Permit2,
 * because the Sweeper pulls tokens the same way regardless of where the
 * leg is pointed: `readAllowances`, `approvalPlan`, `approveTx`,
 * `signSweepPermit`, `buildSweepArgs`, `parseSweepReceipt`.
 */

export type IncinerateStage =
  | 'idle'
  | 'preflight'
  | 'ready'
  | 'approving'
  | 'paused'
  | 'signing'
  | 'burning'
  | 'done'
  | 'error';

export type IncinerateFailureStage = 'preflight' | 'approving' | 'signing' | 'burning';

/** One token queued for destruction, with the balance re-read at
 *  preflight rather than trusted from the scan. Permit2 reverts if the
 *  permitted amount exceeds the balance at execution time, and a scan
 *  can be minutes old. */
export type BurnItem = { token: ScannedToken; amount: bigint };

export type IncinerateState = {
  stage: IncinerateStage;
  items: BurnItem[];
  steps: ApprovalStep[];
  stepsDone: number;
  currentHash: Hex | null;
  receipt: SweepReceipt | null;
  error: string | null;
  failureStage: IncinerateFailureStage | null;
  stoppedByUser: boolean;
};

const INITIAL: IncinerateState = {
  stage: 'idle',
  items: [],
  steps: [],
  stepsDone: 0,
  currentHash: null,
  receipt: null,
  error: null,
  failureStage: null,
  stoppedByUser: false,
};

export function useIncinerate() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [state, setState] = useState<IncinerateState>(INITIAL);
  const stopRef = useRef(false);

  const patch = useCallback(
    (p: Partial<IncinerateState>) => setState((s) => ({ ...s, ...p })),
    [],
  );

  const fail = useCallback(
    (err: unknown, at: IncinerateFailureStage) => {
      if (isUserRejection(err)) {
        patch({ stage: 'paused', stoppedByUser: true });
        return;
      }
      patch({ stage: 'error', error: readableError(err), failureStage: at });
    },
    [patch],
  );

  const reset = useCallback(() => {
    stopRef.current = false;
    setState(INITIAL);
  }, []);

  const assertRightChain = useCallback(async () => {
    const id = await walletClient?.getChainId();
    if (id !== undefined && id !== CHAIN_ID) {
      throw new Error(
        `Your wallet is on chain ${id}, not Robinhood Chain (${CHAIN_ID}). ` +
          'Switch networks and try again. Nothing has been burned.',
      );
    }
  }, [walletClient]);

  /* --- 1. preflight --------------------------------------------------- */

  const preflight = useCallback(
    async (tokens: ScannedToken[]) => {
      if (!publicClient || !address || tokens.length === 0) return;
      stopRef.current = false;
      patch({ ...INITIAL, stage: 'preflight' });

      try {
        const sweeper = requireSweeper();
        const burnAdapter = requireBurnAdapter();

        const config = await readSweeperConfig(publicClient, sweeper, burnAdapter);
        if (!config.adapterAllowed) {
          throw new Error(
            `The Sweeper at ${sweeper} has not whitelisted the BurnAdapter at ` +
              `${burnAdapter}, so a burn would revert. Nothing has been burned.`,
          );
        }

        // Fresh balances. The scan's are as old as the scan, and Permit2
        // reverts outright if the permitted amount is above the balance
        // when the sweep executes.
        const balances = await publicClient.multicall({
          allowFailure: true,
          contracts: tokens.map((t) => ({
            address: t.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [address] as const,
          })),
        });

        const items: BurnItem[] = [];
        tokens.forEach((token, i) => {
          const r = balances[i];
          // A balanceOf that reverts is a token we cannot burn either.
          // Drop it here, in front of the user, rather than mid-batch.
          if (!r || r.status !== 'success') return;
          const amount = r.result as bigint;
          if (amount === 0n) return;
          items.push({ token, amount });
        });

        if (items.length === 0) {
          throw new Error(
            'None of the selected tokens still have a balance to burn. ' +
              'Nothing has been burned.',
          );
        }

        const allowances = await readAllowances(
          publicClient,
          address,
          items.map((i) => i.token.address as Address),
        );
        const steps = approvalPlan(
          items.map((i) => ({
            token: i.token.address as Address,
            symbol: i.token.symbol,
            amount: i.amount,
          })),
          allowances,
        );

        patch({ stage: 'ready', items, steps, stepsDone: 0 });
      } catch (err) {
        fail(err, 'preflight');
      }
    },
    [publicClient, address, patch, fail],
  );

  /* --- 2. approvals, one at a time, stoppable ------------------------- */

  const runApprovals = useCallback(async () => {
    if (!walletClient || !publicClient || !address) return;
    stopRef.current = false;
    patch({ stage: 'approving', stoppedByUser: false });

    try {
      await assertRightChain();
      const steps = state.steps;
      for (let i = state.stepsDone; i < steps.length; i++) {
        if (stopRef.current) {
          patch({ stage: 'paused', stepsDone: i, stoppedByUser: true });
          return;
        }
        const step = steps[i]!;
        const hash = await walletClient.writeContract({
          ...approveTx(step.token, step.amount),
          account: address,
          chain: robinhoodChain,
        });
        patch({ currentHash: hash });
        await publicClient.waitForTransactionReceipt({ hash });
        patch({ stepsDone: i + 1, currentHash: null });
      }
      patch({ stage: 'ready' });
    } catch (err) {
      fail(err, 'approving');
    }
  }, [walletClient, publicClient, address, state.steps, state.stepsDone, assertRightChain, patch, fail]);

  const stop = useCallback(() => {
    stopRef.current = true;
  }, []);

  /* --- 3. sign once, burn once ---------------------------------------- */

  const signAndBurn = useCallback(async () => {
    if (!walletClient || !publicClient || !address) return;
    const items = state.items;
    if (items.length === 0) return;

    try {
      const sweeper = requireSweeper();
      const burnAdapter = requireBurnAdapter();

      patch({ stage: 'signing', stoppedByUser: false });
      await assertRightChain();

      const signed = await signSweepPermit(
        walletClient,
        publicClient,
        address,
        sweeper,
        items.map((i) => ({ token: i.token.address as Address, amount: i.amount })),
      );

      // minOut is 0 and data is empty, and both are load-bearing.
      // BurnAdapter reverts `BurnYieldsNothing` on a non-zero minOut,
      // which is the contract-level guarantee that a leg built here can
      // never be a sell. Do not "fix" this by copying the sell path's
      // slippage handling into it.
      const legs: Leg[] = items.map((i) => ({
        token: i.token.address as Address,
        adapter: burnAdapter,
        minOut: 0n,
        data: '0x' as Hex,
      }));

      const args = buildSweepArgs(signed, legs);

      patch({ stage: 'burning' });

      const code = await publicClient.getCode({ address });
      const delegated = isDelegatedCode(code);

      try {
        await publicClient.simulateContract({
          address: sweeper,
          abi: sweeperAbi,
          functionName: 'sweep',
          args,
          account: address,
        });
      } catch (err) {
        if (delegated && isRevertWithoutData(err)) throw new Error(DELEGATED_REVERT_HINT);
        throw err;
      }

      await assertRightChain();

      const hash = await walletClient.writeContract({
        address: sweeper,
        abi: sweeperAbi,
        functionName: 'sweep',
        args,
        account: address,
        chain: robinhoodChain,
      });
      patch({ currentHash: hash });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(
          'The burn transaction reverted. Nothing was destroyed and your tokens ' +
            'are still in your wallet. You paid gas for the failed transaction.',
        );
      }

      const parsed = parseSweepReceipt(receipt, sweeper);
      if (!parsed) {
        throw new Error(
          'The burn transaction succeeded but emitted no Swept event, which should ' +
            `be impossible. Check ${hash} on the explorer before retrying.`,
        );
      }

      patch({ stage: 'done', receipt: parsed, currentHash: hash });

      // The furnace, now, not on the next poll. `recordLocalSweep` reads
      // the real calldata of this mined tx through the same path the feed
      // uses and is idempotent on the hash, so the counter is true rather
      // than optimistic; `ignite` is the animation cue and carries no
      // number. Neither is awaited: a burn that succeeded on chain must
      // not report failure because a decoration could not be drawn.
      if (parsed.legsFilled > 0) {
        void recordLocalSweep(publicClient, hash);
        ignite();
      }
    } catch (err) {
      fail(err, state.stage === 'signing' ? 'signing' : 'burning');
    }
  }, [walletClient, publicClient, address, state.items, state.stage, assertRightChain, patch, fail]);

  return { state, preflight, runApprovals, stop, signAndBurn, reset };
}
