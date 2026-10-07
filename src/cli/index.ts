import { loadConfig } from '../config/index.ts';
import { createLogger } from '../utils/logger.ts';
import { createAdoClient } from '../sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import { buildPipeline, buildSuggestionPipeline } from '../services/pipeline-builder.ts';
import { applySuggestions, failureOutcome, loadSuggestionConfig } from '../services/apply-suggestions.ts';
import { parseSuggestionInput } from '../suggestions/input.ts';
import { createSuggestionGit } from '../suggestions/suggestion-git.ts';
import { createProcessor } from '../services/processor.ts';
import { createWiLogFactory } from '../services/wi-log.ts';
import { createCostLedger } from '../services/cost-ledger.ts';
import { createWorktreeManager } from '../services/worktree-manager.ts';
import { createContiniaCli } from '../services/continia-cli.ts';
import { sweepClosedPrEnvironments } from '../services/env-cleanup.ts';
import {
  createAbortFlag,
  runPollCycle,
  startWatcher,
} from '../services/watcher.ts';
import type { WorktreeContext } from '../types/index.ts';
import { slugify } from '../utils/slug.ts';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertIsolatedTargetRepo,
  corpusSchema,
  readJsonFile,
  runExperiment,
  variantsSchema,
} from '../services/experiment-runner.ts';
import { createReadOnlyAdoClient } from '../services/read-only-ado.ts';
import { renderExperimentReport } from '../utils/experiment-report.ts';

const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start                       Start the watcher (long-running)
  bun run once                        Run a single poll cycle and exit
  bun run src/cli/index.ts run-wi <id>      Process one work item by ID
  bun run src/cli/index.ts apply-suggestions --input <file> [--dry-run]
                                      Apply mutant-fixer's verified test fixes to a PR
                                      (last stdout line: JSON outcome)
  bun run src/cli/index.ts reset-state <id> Delete state + remove worktree + delete branch
  bun run src/cli/index.ts debug-tags       List WIs tagged with TRIGGER_TAG
  bun run src/cli/index.ts debug-pr <id>    Print the draft-PR record for a work item
  bun run src/cli/index.ts experiment --corpus <file> --variants <file>
                                      Replay corpus WIs under each config variant
                                      (no ADO writes, no push) and write a report
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

Experiment flags:
  --run-id <id>        Reuse/resume experiments/runs/<id> (default: timestamp)
  --reps <n>           Repetitions per WI x variant (default 1)
  --max-total-usd <n>  Stop starting runs once est. spend crosses n
  --only <a,b>         Run only these variants (baseline is always included)
  --no-referee         Skip the baseline-config referee review of each diff
  --base-check-only    Only deploy + test each WI's base commit (no LLM calls)
  --allow-api-key      Keep ANTHROPIC_API_KEY (default: removed, so the
                       Claude Code subscription login is used)

Flags:
  --dry-run         Suppress ADO writes (tags, comments). Pipeline still runs.
  --keep-worktree   (reset-state only) Delete the state file but leave the
                    worktree and branch on disk for inspection.
`);
}

function buildDeps() {
  const config = loadConfig();
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  const logger = createLogger();
  const ado = createAdoClient(config);
  const store = new PipelineStateStore(config.stateDir);
  const abortFlag = createAbortFlag();
  // Dry runs are rehearsals — they must not pollute the real spend log, or
  // leave per-WI log files that look like records of real work.
  const ledger = config.dryRun
    ? undefined
    : createCostLedger({ path: config.costLogPath, logger });
  const wiLogs = config.dryRun
    ? undefined
    : createWiLogFactory({ dir: config.logDir, logger });
  const processor = createProcessor({
    config,
    logger,
    ado,
    store,
    buildPipeline,
    abortFlag,
    ...(ledger ? { ledger } : {}),
    ...(wiLogs ? { wiLogs } : {}),
  });
  // Deleting environments is a write: never in a dry run, and there are none
  // to delete when the verification gate is off.
  const sweepEnvironments =
    config.dryRun || config.skipBuildTest || !config.deleteEnvOnPrClose
      ? undefined
      : () =>
          sweepClosedPrEnvironments({
            config,
            logger,
            ado,
            store,
            continiaCli: createContiniaCli({ config, onRetry: (message) => logger.warn(message) }),
          });
  return { config, logger, ado, store, processor, abortFlag, ...(sweepEnvironments ? { sweepEnvironments } : {}) };
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      help();
      return;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;

    case 'watch': {
      const deps = buildDeps();
      await startWatcher(deps);
      return;
    }

    case 'run-once': {
      const deps = buildDeps();
      const stats = await runPollCycle(deps);
      const environmentsDeleted = deps.sweepEnvironments ? await deps.sweepEnvironments() : 0;
      console.log(JSON.stringify({ ...stats, environmentsDeleted }, null, 2));
      return;
    }

    case 'run-wi': {
      const idArg = process.argv[3];
      if (!idArg) {
        console.error('run-wi requires a work item ID');
        process.exitCode = 1;
        return;
      }
      const id = Number(idArg);
      if (!Number.isFinite(id)) {
        console.error(`invalid work item ID: ${idArg}`);
        process.exitCode = 1;
        return;
      }
      const deps = buildDeps();
      const outcome = await deps.processor.processWorkItem(id);
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }

    case 'reset-state': {
      const idArg = process.argv[3];
      if (!idArg) {
        console.error('reset-state requires a work item ID');
        process.exitCode = 1;
        return;
      }
      const id = Number(idArg);
      if (!Number.isFinite(id)) {
        console.error(`invalid work item ID: ${idArg}`);
        process.exitCode = 1;
        return;
      }
      const keepWorktree = process.argv.includes('--keep-worktree');
      const { config, store, logger } = buildDeps();

      if (!keepWorktree) {
        // Try to recover the persisted worktree info (so we use the LOCKED branch
        // name + path, not a freshly-recomputed slug). Fall back to slugifying
        // a placeholder title — worktree-manager's removeWorktree is best-effort.
        const existing = store.load(id);
        const persistedWorktree = existing?.outputs.worktree as
          | WorktreeContext
          | undefined;
        const slug = existing?.slug ?? slugify(`wi-${id}`);
        const worktreeManager = createWorktreeManager({ config });
        try {
          await worktreeManager.removeWorktree({
            workItemId: id,
            slug,
            persistedWorktree,
          });
          logger.info(`worktree for WI ${id} removed`);
        } catch (err) {
          logger.error(`worktree removal for WI ${id} failed`, err);
        }
      } else {
        logger.info(`--keep-worktree: leaving worktree and branch in place`);
      }

      store.delete(id);
      console.log(`state for WI ${id} deleted`);
      return;
    }

    case 'debug-tags': {
      const { config, ado, logger } = buildDeps();
      logger.info(`querying WIs tagged '${config.triggerTag}'`);
      const ids = await ado.queryWorkItemsByTag(config.triggerTag);
      console.log(JSON.stringify({ tag: config.triggerTag, ids }, null, 2));
      return;
    }

    case 'debug-pr': {
      const idArg = process.argv[3];
      if (!idArg) {
        console.error('debug-pr requires a work item ID');
        process.exitCode = 1;
        return;
      }
      const id = Number(idArg);
      if (!Number.isFinite(id)) {
        console.error(`invalid work item ID: ${idArg}`);
        process.exitCode = 1;
        return;
      }
      const { store } = buildDeps();
      const state = store.load(id);
      const draftPr = state?.outputs.draftPr;
      if (!draftPr) {
        console.log(`no draft PR recorded for WI ${id}`);
        return;
      }
      console.log(JSON.stringify(draftPr, null, 2));
      return;
    }

    case 'apply-suggestions': {
      await runApplySuggestionsCommand();
      return;
    }

    case 'experiment': {
      await runExperimentCommand();
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * mutant-fixer's handover. Expected failures print an ok:false outcome and
 * exit 0; only a crash (bad config, unreadable file) exits non-zero. The JSON
 * is printed last, after every log line, because the logger writes to stdout.
 */
async function runApplySuggestionsCommand(): Promise<void> {
  const inputPath = flagValue('--input');
  if (!inputPath) {
    console.error('apply-suggestions requires --input <file>');
    process.exitCode = 1;
    return;
  }
  const parsed = parseSuggestionInput(readFileSync(inputPath, 'utf-8'));
  if (!parsed.ok) {
    console.log(JSON.stringify(failureOutcome(parsed.error)));
    return;
  }
  const input = parsed.input;
  const config = loadSuggestionConfig(process.env, input);
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  const logger = createLogger('apply-suggestions');
  const ado = createAdoClient(config);
  const git = createSuggestionGit({ config });
  const outcome = await applySuggestions({
    config,
    logger,
    input,
    git,
    stages: buildSuggestionPipeline({ config, logger, ado, git }, input.mode),
    store: new PipelineStateStore(join(config.stateDir, 'suggestions')),
  });
  console.log(JSON.stringify(outcome));
}

async function runExperimentCommand(): Promise<void> {
  const corpusPath = flagValue('--corpus');
  const variantsPath = flagValue('--variants');
  if (!corpusPath || !variantsPath) {
    console.error('experiment requires --corpus <file> and --variants <file>');
    process.exitCode = 1;
    return;
  }
  const logger = createLogger();

  // Local runs bill the operator's Claude Code subscription. The SDK's
  // spawned CLI prefers an API key whenever one is in its environment, so a
  // stray key would silently move a $500 experiment onto API billing.
  if (!process.argv.includes('--allow-api-key')) {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (process.env[key]) {
        delete process.env[key];
        logger.warn(`experiment: removed ${key} from the environment so the subscription login is used (--allow-api-key to keep it)`);
      }
    }
  }

  const corpus = readJsonFile(corpusPath, corpusSchema);
  let variants = readJsonFile(variantsPath, variantsSchema);
  const only = flagValue('--only');
  if (only) {
    const keep = new Set(['baseline', ...only.split(',').map((s) => s.trim())]);
    variants = variants.filter((v) => keep.has(v.name));
  }
  const runId = flagValue('--run-id') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join('experiments', 'runs', runId);
  const maxTotal = flagValue('--max-total-usd');

  // Experiments get their own clone so they never touch the repo production
  // (or the operator's own work) uses; the production paths in .env stay as-is.
  if (process.env.EXPERIMENT_TARGET_REPO_PATH) process.env.TARGET_REPO_PATH = process.env.EXPERIMENT_TARGET_REPO_PATH;
  if (process.env.EXPERIMENT_WORKTREE_BASE) process.env.WORKTREE_BASE = process.env.EXPERIMENT_WORKTREE_BASE;

  // Experiment-only ruleset relaxations (e.g. AA0210 while main is being
  // fixed) live in their own overlay and ruleset, so production runs keep the
  // team rules. The experiment ruleset includes the team .cli-ruleset.json and
  // only adds to it. Defaults to the shipped dir; EXPERIMENT_* override.
  const expOverlay =
    process.env.EXPERIMENT_WORKTREE_OVERLAY_DIR ??
    (existsSync(join(import.meta.dir, '..', '..', 'config', 'worktree-overlay-experiment'))
      ? join(import.meta.dir, '..', '..', 'config', 'worktree-overlay-experiment')
      : undefined);
  if (expOverlay) {
    process.env.WORKTREE_OVERLAY_DIR = [process.env.WORKTREE_OVERLAY_DIR, expOverlay].filter(Boolean).join(',');
    process.env.CONTINIA_RULESET =
      process.env.EXPERIMENT_CONTINIA_RULESET ?? 'Banking Rulesets/.cli-ruleset.experiment.json';
  }
  // A replayed base is usually older than the Continia Banking build that the
  // localization deps install brings onto a fresh environment, and BC refuses
  // to publish it over the newer schema ("Removing fields is not allowed").
  // Experiment environments are throwaway, so forcing the sync is safe here —
  // and only here.
  process.env.CONTINIA_SYNC_MODE = process.env.EXPERIMENT_CONTINIA_SYNC_MODE ?? 'ForceSync';
  const config = loadConfig();
  try {
    await assertIsolatedTargetRepo(config.targetRepoPath, config.worktreeBase);
  } catch (err) {
    console.error(`experiment: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  logger.info(`experiment: target repo ${config.targetRepoPath}, worktrees under ${config.worktreeBase}`);
  logger.info(
    `experiment: overlays ${(config.worktreeOverlayDirs ?? []).join(', ') || '(none)'}; deploy ruleset ${config.continiaRuleset ?? '(CLI auto-discovery)'}; sync mode ${config.continiaSyncMode ?? 'Synchronize (default)'}`,
  );
  const abortFlag = createAbortFlag();
  process.on('SIGINT', () => {
    // A second Ctrl+C means "now". Everything is resumable from state, so
    // the cost of exiting mid-stage is re-running that one stage.
    if (abortFlag.aborted) {
      logger.warn('experiment: second SIGINT — exiting now; rerun with the same --run-id to resume');
      process.exit(130);
    }
    logger.warn('experiment: SIGINT — stopping after the current step (Ctrl+C again to exit now)');
    abortFlag.aborted = true;
  });

  const summary = await runExperiment({
    baseEnv: { ...process.env },
    corpus,
    variants,
    outDir,
    runId,
    reps: Number(flagValue('--reps') ?? 1),
    ...(maxTotal !== undefined ? { maxTotalUsd: Number(maxTotal) } : {}),
    referee: !process.argv.includes('--no-referee'),
    baseCheckOnly: process.argv.includes('--base-check-only'),
    logger,
    ado: createReadOnlyAdoClient(createAdoClient(config)),
    abortFlag,
  });

  const report = renderExperimentReport({
    runId,
    results: summary.results,
    variants: variants.map((v) => v.name),
    overheadUsd: summary.overheadUsd,
    skippedForBudget: summary.skippedForBudget,
    baseChecks: summary.baseChecks,
  });
  writeFileSync(join(outDir, 'report.md'), report, 'utf-8');
  console.log(report);
  console.log(`report written to ${join(outDir, 'report.md')}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
