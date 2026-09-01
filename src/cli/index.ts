import { loadConfig } from '../config/index.ts';
import { createLogger } from '../utils/logger.ts';
import { createAdoClient } from '../sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import { buildPipeline } from '../services/pipeline-builder.ts';
import { createProcessor } from '../services/processor.ts';
import { createWiLogFactory } from '../services/wi-log.ts';
import { createCostLedger } from '../services/cost-ledger.ts';
import { createWorktreeManager } from '../services/worktree-manager.ts';
import {
  createAbortFlag,
  runPollCycle,
  startWatcher,
} from '../services/watcher.ts';
import type { WorktreeContext } from '../types/index.ts';
import { slugify } from '../utils/slug.ts';

const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start                       Start the watcher (long-running)
  bun run once                        Run a single poll cycle and exit
  bun run src/cli/index.ts run-wi <id>      Process one work item by ID
  bun run src/cli/index.ts reset-state <id> Delete state + remove worktree + delete branch
  bun run src/cli/index.ts debug-tags       List WIs tagged with TRIGGER_TAG
  bun run src/cli/index.ts debug-pr <id>    Print the draft-PR record for a work item
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

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
  return { config, logger, ado, store, processor, abortFlag };
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
      console.log(JSON.stringify(stats, null, 2));
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

    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
