import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { useAccount, useCapabilities, usePublicClient, useWalletClient } from 'wagmi';
import { CHAIN_ID, requireSweeper, requireV3Adapter } from '../lib/addresses';
import { atomicStatus, canBatchAtomically, type AtomicStatus } from '../lib/batching';
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
} from '../lib/permit2';
import {
  requoteForSweep,
  type DriftRow,
  type DroppedLeg,
  type SweepLeg,
} from '../lib/requote';
import type { ScannedToken } from '../lib/scan';
import {
  parseSweepReceipt,
  readSweeperConfig,
  sweeperAbi,
  type SweeperConfig,
  type SweepReceipt,
} from '../lib/sweeper';

/**
 * The write half.
 *
 * Reading order, because the sequence is the design:
 *
 *   preflight  read the ceiling, the fee and every allowance, so the
 *              real cost is on screen BEFORE the user commits
 *   approving  one confirmation at a time, stoppable, and what is
 *              already approved stays approved
 *   requoting  fresh balances, allowances and quotes for the selected
 *              tokens only
 *   drift      a downward move past 3% stops here and asks again
 *   signing    one signature over the whole batch
 *   sweeping   simulate, send, wait, read the events back
 *
 * Every terminal state has to answer one question without ambiguity:
 * did my tokens move. That is why the failure branches carry their own
 * copy rather than sharing a generic one.
 */

export type SweepStage =
  | 'idle'
  | 'preflight'
  | 'ready'
  | 'approving'
  | 'paused'
  | 'requoting'
  | 'drift'
  | 'signing'
  | 'sweeping'
  | 'done'
  | 'error';

/** Which step the failure happened on. Drives the recovery copy. */
export type FailureStage = 'preflight' | 'approving' | 'requoting' | 'signing' | 'sweeping';

export type SweepState = {
  stage: SweepStage;
  config: SweeperConfig | null;
  /** Remaining wallet confirmations for the current selection. */
  steps: ApprovalStep[];
  /** How many of `steps` are done in this run. Survives a pause. */
  stepsDone: number;
  currentHash: Hex | null;
  legs: SweepLeg[];
  dropped: DroppedLeg[];
  drifted: DriftRow[];
  receipt: SweepReceipt | null;
  error: string | null;
  failureStage: FailureStage | null;
  /** True when the user stopped rather than something breaking. */
  stoppedByUser: boolean;
};

const INITIAL: SweepState = {
  stage: 'idle',
  config: null,
  steps: [],
  stepsDone: 0,
  currentHash: null,
  legs: [],
  dropped: [],
  drifted: [],
  receipt: null,
  error: null,
  failureStage: null,
  stoppedByUser: false,
};

/** Stages where a selection change must not yank the ground away. */
const BUSY: ReadonlySet<SweepStage> = new Set<SweepStage>([
  'approving',
  'requoting',
  'drift',
  'signing',
  'sweeping',
]);

export function useSweep(opts: {
  selected: ScannedToken[];
  gasCostPerLegWei: bigint;
}) {
  const { selected, gasCostPerLegWei } = opts;
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { data: capabilities } = useCapabilities({ query: { retry: false } });

  const [state, setState] = useState<SweepState>(INITIAL);
  const [preflightNonce, setPreflightNonce] = useState(0);
  /**
   * Does the connected account have code, i.e. an EIP-7702 delegation.
   * Held OUTSIDE `state` so a reset does not wipe it: it is a fact about
   * the wallet, not a step in the flow.
   */
  const [delegated, setDelegated] = useState(false);
  const stopRef = useRef(false);
  const stageRef = useRef<SweepStage>('idle');
  stageRef.current = state.stage;

  /**
   * Once on connect. With code on the account Permit2 takes the ERC-1271
   * branch instead of ecrecover, and for a delegate that does not answer
   * it, the sweep reverts with no data at all. Whether MetaMask's own
   * smart-account delegator answers correctly is UNVERIFIED, so this
   * warns and never blocks. See lib/delegation.ts.
   */
  useEffect(() => {
    setDelegated(false);
    if (!publicClient || !address) return;
    let cancelled = false;
    void (async () => {
      try {
        const code = await publicClient.getCode({ address });
        if (!cancelled) setDelegated(isDelegatedCode(code));
      } catch {
        // A code read that fails is not evidence of anything, and a
        // warning nobody can act on is worse than no warning.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address]);

  const atomic: AtomicStatus = useMemo(
    () => atomicStatus(capabilities, CHAIN_ID),
    [capabilities],
  );

  const patch = useCallback(
    (p: Partial<SweepState>) => setState((prev) => ({ ...prev, ...p })),
    [],
  );

  const reset = useCallback(() => {
    stopRef.current = false;
    setState(INITIAL);
  }, []);

  // A selection change while a sweep is in flight would leave the legs
  // and the checkboxes describing different batches. The card disables
  // the rows during those stages; this is the belt to that's braces.
  const selectionKey = useMemo(
    () =>
      selected
        .map((t) => `${t.address.toLowerCase()}:${t.balance}`)
        .sort()
        .join(','),
    [selected],
  );

  // Nothing survives a wallet or chain change. Declared above the
  // preflight effect and guarded on a real change: on mount it would
  // otherwise fire second and wipe the preflight that just started.
  const walletKey = `${address ?? ''}:${chainId ?? ''}`;
  const walletKeyRef = useRef(walletKey);
  useEffect(() => {
    if (walletKeyRef.current === walletKey) return;
    walletKeyRef.current = walletKey;
    stopRef.current = false;
    setState(INITIAL);
  }, [walletKey]);

  /* --- 1. preflight: the real cost, before they commit ---------------- */

  useEffect(() => {
    if (BUSY.has(stageRef.current) || stageRef.current === 'done') return;
    if (!publicClient || !address || selected.length === 0) {
      if (stageRef.current !== 'idle') setState(INITIAL);
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, stage: 'preflight', error: null, failureStage: null }));

    (async () => {
      try {
        const sweeper = requireSweeper();
        const adapter = requireV3Adapter();

        const [config, allowances] = await Promise.all([
          readSweeperConfig(publicClient, sweeper, adapter),
          readAllowances(
            publicClient,
            address,
            selected.map((t) => t.address),
          ),
        ]);
        if (cancelled) return;

        if (!config.adapterAllowed) {
          throw new Error(
            `The Sweeper at ${sweeper} does not have the adapter at ${adapter} ` +
              'whitelisted. Check VITE_SWEEPER and VITE_V3_ADAPTER came from the ' +
              'same deploy.',
          );
        }

        const steps = approvalPlan(
          selected.map((t) => ({
            token: t.address,
            symbol: t.symbol,
            amount: t.balance,
          })),
          allowances,
        );

        setState((prev) => ({
          ...prev,
          stage: 'ready',
          config,
          steps,
          stepsDone: 0,
          error: null,
          failureStage: null,
          stoppedByUser: false,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          stage: 'error',
          error: readableError(err),
          failureStage: 'preflight',
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // `selectionKey` stands in for `selected`: same tokens at the same
    // balances means the same preflight, and re-running it on every
    // render of a new array would hammer the RPC.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, address, selectionKey, preflightNonce]);

  /* --- shared guards -------------------------------------------------- */

  const assertRightChain = useCallback(async () => {
    if (!walletClient) throw new Error('No wallet connected.');
    const live = await walletClient.getChainId();
    if (live !== CHAIN_ID) {
      throw new Error(
        `Your wallet is on chain ${live}, not ${robinhoodChain.name} (${CHAIN_ID}). ` +
          'Nothing was sent. Switch back and press Sweep again.',
      );
    }
  }, [walletClient]);

  /* --- 2. approvals, one at a time, stoppable ------------------------- */

  const runApprovals = useCallback(
    async (steps: ApprovalStep[], alreadyDone: number): Promise<boolean> => {
      if (!walletClient || !publicClient || !address) return false;

      for (let i = alreadyDone; i < steps.length; i++) {
        if (stopRef.current) {
          patch({ stage: 'paused', stepsDone: i, stoppedByUser: true });
          return false;
        }

        const step = steps[i];
        patch({ stage: 'approving', stepsDone: i, currentHash: null });

        await assertRightChain();

        const hash = await walletClient.writeContract({
          ...approveTx(step.token, step.amount),
          account: address,
          chain: robinhoodChain,
        });
        patch({ currentHash: hash });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') {
          throw new Error(
            `The ${step.kind === 'reset' ? 'allowance reset' : 'approval'} for ` +
              `${step.symbol} reverted on chain. Nothing has been sold.`,
          );
        }

        patch({ stepsDone: i + 1, currentHash: null });
      }

      return true;
    },
    [walletClient, publicClient, address, assertRightChain, patch],
  );

  /* --- 4 & 5. sign the batch, then sweep ------------------------------ */

  const signAndSweep = useCallback(
    async (legs: SweepLeg[]) => {
      if (!walletClient || !publicClient || !address) return;

      const sweeper = requireSweeper();
      const adapter = requireV3Adapter();

      patch({ stage: 'signing', currentHash: null });
      await assertRightChain();

      let signed;
      try {
        signed = await signSweepPermit(
          walletClient,
          publicClient,
          address,
          sweeper,
          legs.map((l) => ({ token: l.token.address, amount: l.amount })),
        );
      } catch (err) {
        if (isUserRejection(err)) {
          patch({
            stage: 'error',
            error:
              'You rejected the signature. Nothing was sold and nothing was sent. ' +
              'Your approvals are still in place, so pressing Sweep again picks up ' +
              'from the signature.',
            failureStage: 'signing',
            stoppedByUser: true,
          });
          return;
        }
        throw err;
      }

      // Legs are built in the same order as `permitted`, and
      // buildSweepArgs throws if they ever disagree. That check is what
      // stops a leg being pointed at a token the user never signed for.
      const args = buildSweepArgs(
        signed,
        legs.map((l) => ({
          token: l.token.address,
          adapter,
          minOut: l.minOut,
          data: l.data,
        })),
      );

      patch({ stage: 'sweeping' });

      // Simulate before sending. A batch that cannot succeed should cost
      // the user nothing, and this is the last point where that is still
      // true: they have signed, but signing is free.
      //
      // The will-it-move probe during the scan is a filter in front of
      // this, not a replacement for it. This still catches everything the
      // probe could not: a pool that moved, an allowance spent elsewhere,
      // a token that only misbehaves once it is actually being pulled.
      try {
        await publicClient.simulateContract({
          address: sweeper,
          abi: sweeperAbi,
          functionName: 'sweep',
          args,
          account: address,
        });
      } catch (err) {
        // A revert with NO data, on a wallet that has code, is Permit2's
        // ERC-1271 branch and almost nothing else. Naming it beats the
        // generic copy, which would send the user hunting a pool problem
        // that is not there.
        if (delegated && isRevertWithoutData(err)) {
          throw new Error(DELEGATED_REVERT_HINT);
        }
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
          'The sweep transaction reverted. Nothing was sold and your tokens are ' +
            'still in your wallet. You paid gas for the failed transaction.',
        );
      }

      const parsed = parseSweepReceipt(receipt, sweeper);
      if (!parsed) {
        throw new Error(
          'The sweep transaction succeeded but emitted no Swept event, which ' +
            `should be impossible. Check ${hash} on the explorer before retrying.`,
        );
      }

      patch({ stage: 'done', receipt: parsed, currentHash: hash });
    },
    [walletClient, publicClient, address, assertRightChain, patch, delegated],
  );

  /* --- 3. re-quote, then hand off ------------------------------------- */

  const requoteThenSweep = useCallback(
    async (config: SweeperConfig) => {
      if (!publicClient || !address) return;

      patch({ stage: 'requoting', currentHash: null });

      const result = await requoteForSweep({
        client: publicClient,
        owner: address,
        tokens: selected,
        gasCostPerLegWei,
        maxLegValueWei: config.maxLegValueWei,
      });

      patch({ legs: result.legs, dropped: result.dropped, drifted: result.drifted });

      if (result.legs.length === 0) {
        patch({
          stage: 'error',
          error:
            'Nothing is left to sweep. Every token you picked was dropped when it ' +
            'was re-priced. Nothing was signed and nothing was sent.',
          failureStage: 'requoting',
        });
        return;
      }

      // A downward move past the threshold stops here on purpose. The
      // user agreed to a number and the number changed.
      if (result.drifted.length > 0) {
        patch({ stage: 'drift' });
        return;
      }

      await signAndSweep(result.legs);
    },
    [publicClient, address, selected, gasCostPerLegWei, patch, signAndSweep],
  );

  /* --- the button ----------------------------------------------------- */

  const fail = useCallback((stage: FailureStage, err: unknown) => {
    if (isUserRejection(err)) {
      setState((prev) => ({
        ...prev,
        stage: 'error',
        stoppedByUser: true,
        error:
          'You rejected the request in your wallet. Nothing was sent and nothing ' +
          'was sold.',
        failureStage: stage,
      }));
      return;
    }
    setState((prev) => ({
      ...prev,
      stage: 'error',
      error: readableError(err),
      failureStage: stage,
    }));
  }, []);

  /**
   * The seam. `runApprovals` sends one transaction per confirmation
   * because 4663 is not in MetaMask's atomic list. When it turns up
   * there and the batched path has been clicked through once,
   * `ATOMIC_READY` flips and this dispatches to a single `useSendCalls`
   * instead. Nothing either side of it changes: the plan, the re-quote,
   * the permit and the receipt do not know how the approvals were sent.
   */
  const sendApprovals = useCallback(
    async (steps: ApprovalStep[], alreadyDone: number): Promise<boolean> => {
      if (canBatchAtomically(atomic)) {
        throw new Error(
          'Atomic batching is switched on in lib/batching.ts but the batched ' +
            'path is not written yet. Set ATOMIC_READY back to false.',
        );
      }
      return runApprovals(steps, alreadyDone);
    },
    [atomic, runApprovals],
  );

  const start = useCallback(async () => {
    const config = state.config;
    if (!config) return;
    stopRef.current = false;

    try {
      const finished = await sendApprovals(state.steps, state.stepsDone);
      // Stopped between confirmations. Everything already approved stays
      // approved, so this is a pause, not a failure.
      if (!finished) return;
    } catch (err) {
      if (isUserRejection(err)) {
        setState((prev) => ({ ...prev, stage: 'paused', stoppedByUser: true }));
        return;
      }
      fail('approving', err);
      return;
    }

    try {
      await requoteThenSweep(config);
    } catch (err) {
      // Which step it died on decides what the user is told about their
      // tokens, so read the live stage rather than guessing.
      const at = stageRef.current;
      fail(at === 'signing' || at === 'sweeping' ? at : 'requoting', err);
    }
  }, [state.config, state.steps, state.stepsDone, sendApprovals, requoteThenSweep, fail]);

  const stop = useCallback(() => {
    stopRef.current = true;
  }, []);

  const confirmDrift = useCallback(async () => {
    if (state.legs.length === 0) return;
    try {
      await signAndSweep(state.legs);
    } catch (err) {
      const at = stageRef.current;
      fail(at === 'sweeping' ? 'sweeping' : 'signing', err);
    }
  }, [state.legs, signAndSweep, fail]);

  const cancelDrift = useCallback(() => {
    patch({
      stage: 'error',
      stoppedByUser: true,
      error:
        'Cancelled after re-pricing. Nothing was signed and nothing was sold. ' +
        'Your approvals are still in place.',
      failureStage: 'requoting',
    });
  }, [patch]);

  /** Re-run preflight after a failure that had nothing to sweep with. */
  const retry = useCallback(() => {
    setState((prev) => ({ ...prev, stage: 'idle', error: null, failureStage: null }));
    setPreflightNonce((n) => n + 1);
  }, []);


  return {
    ...state,
    atomic,
    /** True when the account carries an EIP-7702 delegation. */
    delegated,
    /** Remaining confirmations for the current selection. */
    approvalsRemaining: Math.max(0, state.steps.length - state.stepsDone),
    start,
    stop,
    confirmDrift,
    cancelDrift,
    retry,
    reset,
  };
}
