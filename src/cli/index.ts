import { loadConfig } from '../config/index.ts';
import { createLogger } from '../utils/logger.ts';
import { createAdoClient } from '../sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import { buildPipeline } from '../services/pipeline-builder.ts';
import { createProcessor } from '../services/processor.ts';
import {
  createAbortFlag,
  runPollCycle,
  startWatcher,
} from '../services/watcher.ts';

const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start                       Start the watcher (long-running)
  bun run once                        Run a single poll cycle and exit
  bun run src/cli/index.ts run-wi <id>      Process one work item by ID
  bun run src/cli/index.ts reset-state <id> Delete state for one work item
  bun run src/cli/index.ts debug-tags       List WIs tagged with TRIGGER_TAG
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

Flags:
  --dry-run         Suppress ADO writes (tags, comments). Pipeline still runs.
`);
}

function buildDeps() {
  const config = loadConfig();
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  const logger = createLogger();
  const ado = createAdoClient(config);
  const store = new PipelineStateStore(config.stateDir);
  const abortFlag = createAbortFlag();
  const processor = createProcessor({
    config,
    logger,
    ado,
    store,
    buildPipeline,
    abortFlag,
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
      const { store } = buildDeps();
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
