import { join } from 'path';
import type { Stage } from '../pipeline/stage.ts';
import { createAdoClient } from '../sdk/azure-devops-client.ts';
import { createContiniaCli } from '../services/continia-cli.ts';
import { buildPrFixFinishStages, buildPrFixPipeline } from '../services/pipeline-builder.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import type { GitLock } from '../utils/git-lock.ts';
import type { Logger } from '../utils/logger.ts';
import type { PrFixConfig } from './config.ts';
import { ninjaFactoryFor, type FixPrDeps } from './fix-pr.ts';
import { createPrFixGit } from './prfix-git.ts';

/** What every fix-pr run of one process shares; the per-run fields come from the caller. */
export type PrFixSharedDeps = Pick<FixPrDeps, 'prfix' | 'logger' | 'ado' | 'git' | 'continiaCli' | 'store' | 'ninja'>;

export interface PrFixRuntime {
  deps: PrFixSharedDeps;
  /** The fix-pr pipeline; with `holdBeforePush` it stops before `push-rebased`. */
  pipeline(opts: { keepEnv: boolean; holdBeforePush?: boolean }): Stage[];
  /** `[push-rebased, pr-comment]`, for `approvePrFix`. */
  finishStages(opts: { keepEnv: boolean }): Stage[];
}

/**
 * Builds the fix-pr dependencies the same way for the `fix-pr` CLI and the
 * watcher's dashboard worker, so the two cannot drift. One Ninja factory serves
 * the stage and the release of unpushed IDs; every call is a fresh client,
 * since the stage closes its own. State lives in `<stateDir>/prfix`.
 */
export function createPrFixRuntime(args: { prfix: PrFixConfig; logger: Logger; gitLock?: GitLock }): PrFixRuntime {
  const { prfix, logger } = args;
  const config = prfix.app;
  const ado = createAdoClient(config);
  const git = createPrFixGit({ config, logger, ...(args.gitLock ? { gitLock: args.gitLock } : {}) });
  const continiaCli = createContiniaCli({ config, onRetry: (message) => logger.warn(message) });
  const ninja = ninjaFactoryFor(prfix);
  const store = new PipelineStateStore(join(config.stateDir, 'prfix'));
  return {
    deps: { prfix, logger, ado, git, continiaCli, store, ninja },
    pipeline: ({ keepEnv, holdBeforePush }) =>
      buildPrFixPipeline({ prfix, logger, ado, git, continiaCli, keepEnv, ninja, ...(holdBeforePush ? { holdBeforePush } : {}) }),
    finishStages: ({ keepEnv }) => buildPrFixFinishStages({ ado, git, keepEnv }),
  };
}
