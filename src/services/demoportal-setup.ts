import { isAbsolute, resolve } from 'path';
import type { AppConfig } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';
import { continiaProcessEnv } from './continia-cli.ts';
import { DemoPortalAuth } from './demoportal-auth.ts';
import { runProcess, type RunProcess } from './process-runner.ts';
import type { WakeFlag } from './watcher.ts';

/**
 * The DemoPortal sign-in service and the flag it uses to wake the watcher, or
 * undefined when there is nothing to sign in to: an API token, or
 * SKIP_BUILD_TEST (no job uses the Continia CLI, so the sign-in must not hold work).
 */
export function createDemoPortal(
  config: AppConfig,
  logger: Pick<Logger, 'info'>,
  run: RunProcess = (cmd, cwd, _env, t, onLine) => runProcess(cmd, cwd, continiaProcessEnv(config), t, onLine),
): { demoPortal: DemoPortalAuth; wake: WakeFlag } | undefined {
  if (config.continiaAuthMethod !== 'azure-ad' || config.skipBuildTest) return undefined;
  const wake: WakeFlag = { requested: false };
  // A relative CONTINIA_CLI_PATH resolves like the CLI calls made outside a
  // worktree (env-cleanup): against the target repo, not the process cwd.
  const cli = isAbsolute(config.continiaCliPath) ? config.continiaCliPath : resolve(config.targetRepoPath, config.continiaCliPath);
  const demoPortal = new DemoPortalAuth(cli, process.cwd(), run, (m) => logger.info(m));
  demoPortal.onSignedIn = () => {
    wake.requested = true;
  };
  return { demoPortal, wake };
}
