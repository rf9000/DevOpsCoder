import { join } from 'path';
import type { AbortFlag } from '../../pipeline/stage.ts';
import type { AdoClient } from '../../sdk/azure-devops-client.ts';
import type { DemoPortalSession } from '../../services/demoportal-auth.ts';
import type { PipelineStateStore } from '../../state/state-store.ts';
import type { AppConfig, DraftPrOutput, PipelineState } from '../../types/index.ts';
import type { GitLock } from '../../utils/git-lock.ts';
import { createLogger, type Logger } from '../../utils/logger.ts';
import { loadPrFixConfig, type PrFixConfig } from '../config.ts';
import { approvePrFix, cleanupInterruptedPrFix, fixPr, rejectPrFix } from '../fix-pr.ts';
import { createPrFixRuntime, type PrFixRuntime } from '../runtime.ts';
import { PrFixCatalog } from './catalog.ts';
import { PrFixJobStore } from './store.ts';
import { createPrFixWorker, type PrFixWorker } from './worker.ts';

/** How often the active-PR list is re-read (it is also re-read after every job). */
export const CATALOG_REFRESH_MS = 120_000;

/** The default approval TTL when the fix-pr config could not load (nothing can be pending then anyway). */
const FALLBACK_TTL_HOURS = 24;

/**
 * The fix-pr config, or why the dashboard PR fixer is off. The fixer never runs
 * in a dry run (a rehearsal must not push) nor with SKIP_BUILD_TEST (it would
 * push an unverified rebase).
 */
export function resolvePrFixer(
  env: Record<string, string | undefined>,
  watcherConfig: Pick<AppConfig, 'dryRun' | 'skipBuildTest'>,
  load: (env: Record<string, string | undefined>) => PrFixConfig = loadPrFixConfig,
): { prfix: PrFixConfig | null; unavailableReason: string | null } {
  let prfix: PrFixConfig;
  try {
    prfix = load(env);
  } catch (err) {
    return { prfix: null, unavailableReason: err instanceof Error ? err.message : String(err) };
  }
  if (watcherConfig.dryRun || prfix.app.dryRun) return { prfix, unavailableReason: 'DRY_RUN is set' };
  if (watcherConfig.skipBuildTest || prfix.app.skipBuildTest) {
    return { prfix, unavailableReason: 'SKIP_BUILD_TEST is set: fix-pr would push an unverified rebase' };
  }
  return { prfix, unavailableReason: null };
}

/** A work item running in this watcher whose draft PR is `prId`: fix-pr must not write the same branch. */
export function wiRunningForPr(states: PipelineState[], prId: number): boolean {
  return states.some(
    (s) =>
      (s.outputs.draftPr as DraftPrOutput | undefined)?.id === prId &&
      s.currentStage != null &&
      !s.terminalError &&
      !s.cancelled,
  );
}

export interface DashboardPrFixerDeps {
  env: Record<string, string | undefined>;
  /** The watcher's own config; its `dryRun` comes from the `--dry-run` flag (there is no DRY_RUN variable). */
  config: AppConfig;
  /** The watcher's ADO client; lists the active PRs. */
  ado: AdoClient;
  /** The work items' state store. */
  wiStore: PipelineStateStore;
  /** The watcher's abort flag: SIGTERM cancels a running job, and nothing new starts. */
  abortFlag: AbortFlag;
  /** Shared with the work items' worktree manager. */
  gitLock: GitLock;
  logger: Logger;
  demoPortal?: DemoPortalSession;
  now?: () => Date;
}

export interface DashboardPrFixer {
  worker: PrFixWorker;
  catalog: PrFixCatalog;
  /** Refreshes the PR list now and every CATALOG_REFRESH_MS; returns the stop function. */
  startCatalogRefresh(): () => void;
}

/**
 * The watcher's dashboard fix-pr worker: jobs run `fixPr` in hold mode with
 * the same dependencies the CLI builds (`createPrFixRuntime`); approve and
 * reject run the held state's finish or discard. When the fix-pr config cannot
 * load, or the watcher is a dry run / SKIP_BUILD_TEST, the worker reports
 * itself unavailable and the work items run as before.
 */
export function createDashboardPrFixer(deps: DashboardPrFixerDeps): DashboardPrFixer {
  const now = deps.now ?? (() => new Date());
  const { prfix, unavailableReason } = resolvePrFixer(deps.env, deps.config);
  if (unavailableReason) deps.logger.warn(`fix-pr dashboard unavailable: ${unavailableReason}`);
  const runtime: PrFixRuntime | null = prfix
    ? createPrFixRuntime({ prfix, logger: createLogger('fix-pr'), gitLock: deps.gitLock })
    : null;
  const need = (): PrFixRuntime => {
    if (!runtime) throw new Error(unavailableReason ?? 'PR fixer not configured');
    return runtime;
  };
  const repo = prfix?.app.repositoryName ?? deps.config.repositoryName;
  const catalog = new PrFixCatalog(() => deps.ado.listActivePullRequests(repo), now);

  const worker = createPrFixWorker({
    store: new PrFixJobStore(join(deps.config.stateDir, 'prfix')),
    catalog,
    repo,
    unavailableReason,
    signInNeeded: () => deps.demoPortal?.status().needed === true,
    wiRunningForPr: (prId) => wiRunningForPr(deps.wiStore.listAll(), prId),
    runJob: (pullRequestId, onProgress) => {
      const rt = need();
      return fixPr({
        ...rt.deps,
        stages: rt.pipeline({ keepEnv: false, holdBeforePush: true }),
        pullRequestId,
        keepEnv: false,
        holdBeforePush: true,
        abortFlag: deps.abortFlag,
        onProgress,
      });
    },
    approve: (pullRequestId) => {
      const rt = need();
      return approvePrFix({
        ...rt.deps,
        stages: [],
        finishStages: rt.finishStages({ keepEnv: false }),
        pullRequestId,
        keepEnv: false,
        abortFlag: deps.abortFlag,
      });
    },
    reject: (pullRequestId) => {
      const rt = need();
      return rejectPrFix({ ...rt.deps, stages: [], pullRequestId, keepEnv: false, abortFlag: deps.abortFlag });
    },
    cleanupInterrupted: async (pullRequestId) => {
      if (!runtime) {
        deps.logger.warn(`fix-pr: cannot clean up interrupted PR ${pullRequestId}: ${unavailableReason ?? 'no config'}`);
        return;
      }
      await cleanupInterruptedPrFix({ ...runtime.deps, stages: [], pullRequestId, keepEnv: false });
    },
    ttlHours: prfix?.approvalTtlHours ?? FALLBACK_TTL_HOURS,
    logger: deps.logger,
    now,
    stopping: () => deps.abortFlag.aborted,
  });

  return {
    worker,
    catalog,
    startCatalogRefresh() {
      void catalog.refresh();
      const timer = setInterval(() => void catalog.refresh(), CATALOG_REFRESH_MS);
      return () => clearInterval(timer);
    },
  };
}
