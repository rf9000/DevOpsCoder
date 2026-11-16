import { describe, test, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPollCycle, createAbortFlag, sleepInterruptible, startWatcher } from '../../src/services/watcher.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { makeTestConfig } from '../helpers/app-config.ts';
import type { DemoPortalSession } from '../../src/services/demoportal-auth.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { Processor } from '../../src/services/processor.ts';

function setup(ids: number[], demoPortal?: DemoPortalSession) {
  const infoLines: string[] = [];
  const warnLines: string[] = [];
  const processWorkItem = mock(async (id: number) => ({ kind: 'skipped' as const, workItemId: id, reason: 'x' }));
  const deps = {
    config: makeTestConfig(),
    logger: { info: (m: string) => infoLines.push(m), warn: (m: string) => warnLines.push(m), error: () => {} },
    ado: { queryWorkItemsByTag: async () => ids } as unknown as AdoClient,
    store: new PipelineStateStore(mkdtempSync(join(tmpdir(), 'wsi-'))),
    processor: { processWorkItem } as unknown as Processor,
    abortFlag: createAbortFlag(),
    ...(demoPortal ? { demoPortal } : {}),
  };
  return { deps, infoLines, warnLines, processWorkItem };
}

const session = (ensure: boolean, peek: () => Promise<void> = async () => {}): DemoPortalSession => ({
  status: () => ({ needed: !ensure, reason: null, checkedAt: null, login: null }),
  peek,
  ensure: async () => ensure,
  startLogin: async () => {
    throw new Error('unused');
  },
});

describe('runPollCycle sign-in', () => {
  test('holds work when sign-in is needed', async () => {
    const { deps, infoLines, processWorkItem } = setup([1, 2], session(false));
    const stats = await runPollCycle(deps);
    expect(processWorkItem).not.toHaveBeenCalled();
    expect(infoLines).toContain(
      'DemoPortal sign-in needed; 2 work item(s) wait. Sign in from the dashboard or run continia auth login',
    );
    expect(stats.considered).toBe(2);
    expect(stats.completed + stats.failed + stats.skipped).toBe(0);
  });

  test('runs work when signed in', async () => {
    const { deps, processWorkItem } = setup([1], session(true));
    await runPollCycle(deps);
    expect(processWorkItem).toHaveBeenCalledTimes(1);
  });

  test('runs work without demoPortal (api-token)', async () => {
    const { deps, processWorkItem } = setup([1]);
    await runPollCycle(deps);
    expect(processWorkItem).toHaveBeenCalledTimes(1);
  });

  test('a throwing ensure is logged and treated as signed in: work runs', async () => {
    const throwing: DemoPortalSession = {
      ...session(true),
      ensure: async () => {
        throw new Error('spawn continia ENOENT');
      },
    };
    const { deps, warnLines, processWorkItem } = setup([1], throwing);
    await runPollCycle(deps);
    expect(processWorkItem).toHaveBeenCalledTimes(1);
    expect(warnLines).toContain('DemoPortal sign-in check failed - spawn continia ENOENT');
  });

  test('peeks when there are no candidates, and survives a throwing peek', async () => {
    const peek = mock(async () => {
      throw new Error('boom');
    });
    const { deps } = setup([], session(true, peek));
    const stats = await runPollCycle(deps);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(stats.considered).toBe(0);
  });
});

describe('startWatcher environment sweep', () => {
  // One loop: whatever runs last in the cycle sets the abort flag, so startWatcher returns.
  test('skips the sweep while DemoPortal sign-in is needed', async () => {
    const { deps, infoLines } = setup([], session(false));
    const sweepEnvironments = mock(async () => 0);
    deps.logger.info = (m: string) => {
      if (m.startsWith('environment sweep skipped')) deps.abortFlag.aborted = true;
      return infoLines.push(m);
    };
    await startWatcher({ ...deps, sweepEnvironments });
    expect(sweepEnvironments).not.toHaveBeenCalled();
    expect(infoLines).toContain('environment sweep skipped - DemoPortal sign-in needed');
  });

  test('sweeps when signed in', async () => {
    const { deps } = setup([], session(true));
    const sweepEnvironments = mock(async () => {
      deps.abortFlag.aborted = true;
      return 0;
    });
    await startWatcher({ ...deps, sweepEnvironments });
    expect(sweepEnvironments).toHaveBeenCalledTimes(1);
  });
});

describe('sleepInterruptible', () => {
  test('returns early on wake', async () => {
    const wake = { requested: false };
    setTimeout(() => {
      wake.requested = true;
    }, 300);
    const t0 = Date.now();
    await sleepInterruptible(60_000, createAbortFlag(), wake);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(wake.requested).toBe(false);
  });
});
