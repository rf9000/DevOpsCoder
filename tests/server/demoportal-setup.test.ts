import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { createDemoPortal } from '../../src/services/demoportal-setup.ts';
import type { ProcessResult, RunProcess } from '../../src/services/process-runner.ts';
import { createAbortFlag, runPollCycle } from '../../src/services/watcher.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { Processor } from '../../src/services/processor.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const ok: ProcessResult = { exitCode: 0, stdout: '{"azureAd":{"signedIn":true,"sessionValid":true}}', stderr: '', timedOut: false };

describe('createDemoPortal', () => {
  test('SKIP_BUILD_TEST: no sign-in service, and work runs', async () => {
    const config = makeTestConfig({}, { continiaAuthMethod: 'azure-ad', skipBuildTest: true });
    expect(createDemoPortal(config, logger)).toBeUndefined();
    const processWorkItem = mock(async (id: number) => ({ kind: 'skipped' as const, workItemId: id, reason: 'x' }));
    await runPollCycle({
      config, logger,
      ado: { queryWorkItemsByTag: async () => [7] } as unknown as AdoClient,
      store: new PipelineStateStore(mkdtempSync(join(tmpdir(), 'dps-'))),
      processor: { processWorkItem } as unknown as Processor,
      abortFlag: createAbortFlag(),
      ...createDemoPortal(config, logger),
    });
    expect(processWorkItem).toHaveBeenCalledTimes(1);
  });

  test('api-token: no sign-in service', () => {
    expect(createDemoPortal(makeTestConfig({}, { continiaAuthMethod: 'api-token', skipBuildTest: false }), logger)).toBeUndefined();
  });

  test('azure-ad with the build gate: a sign-in service whose CLI path is absolute', async () => {
    const config = makeTestConfig({}, { continiaAuthMethod: 'azure-ad', skipBuildTest: false, continiaCliPath: '.tools/continia.exe', targetRepoPath: '/repo' });
    const calls: string[][] = [];
    const run: RunProcess = async (cmd) => {
      calls.push(cmd);
      return ok;
    };
    const made = createDemoPortal(config, logger, run);
    expect(made?.demoPortal).toBeDefined();
    expect(made?.wake).toEqual({ requested: false });
    await made!.demoPortal.peek();
    // Resolved like the real CLI calls outside a worktree (env-cleanup): against the target repo.
    expect(calls[0]![0]).toBe(resolve('/repo', '.tools/continia.exe'));
    expect(isAbsolute(calls[0]![0]!)).toBe(true);
  });

  test('an absolute CLI path is kept', async () => {
    const abs = resolve('/usr/local/bin/continia');
    const config = makeTestConfig({}, { continiaAuthMethod: 'azure-ad', skipBuildTest: false, continiaCliPath: abs });
    const calls: string[][] = [];
    const made = createDemoPortal(config, logger, async (cmd) => {
      calls.push(cmd);
      return ok;
    });
    await made!.demoPortal.peek();
    expect(calls[0]![0]).toBe(abs);
  });
});
