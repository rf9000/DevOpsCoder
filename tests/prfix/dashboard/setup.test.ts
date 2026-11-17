import { describe, expect, test } from 'bun:test';
import { resolvePrFixer, wiRunningForPr } from '../../../src/prfix/dashboard/setup.ts';
import type { PrFixConfig } from '../../../src/prfix/config.ts';
import type { PipelineState } from '../../../src/types/index.ts';

function prfixWith(app: { dryRun?: boolean; skipBuildTest?: boolean }): PrFixConfig {
  return { app: { dryRun: false, skipBuildTest: false, ...app } } as unknown as PrFixConfig;
}

describe('resolvePrFixer', () => {
  const ok = { dryRun: false, skipBuildTest: false };

  test('available when the config loads and neither flag is set', () => {
    const prfix = prfixWith({});
    expect(resolvePrFixer({}, ok, () => prfix)).toEqual({ prfix, unavailableReason: null });
  });

  test('a config that fails to load makes it unavailable with the error', () => {
    const r = resolvePrFixer({}, ok, () => {
      throw new Error('Invalid configuration:\n  - BOT_GIT_NAME: required for fix-pr');
    });
    expect(r).toEqual({ prfix: null, unavailableReason: 'Invalid configuration:\n  - BOT_GIT_NAME: required for fix-pr' });
  });

  test('a dry run (the watcher --dry-run flag, or a dry-run fix-pr config)', () => {
    expect(resolvePrFixer({}, ok, () => prfixWith({ dryRun: true })).unavailableReason).toBe('DRY_RUN is set');
    expect(resolvePrFixer({}, { ...ok, dryRun: true }, () => prfixWith({})).unavailableReason).toBe('DRY_RUN is set');
  });

  test('SKIP_BUILD_TEST', () => {
    expect(resolvePrFixer({}, ok, () => prfixWith({ skipBuildTest: true })).unavailableReason).toBe(
      'SKIP_BUILD_TEST is set: fix-pr would push an unverified rebase',
    );
  });
});

describe('wiRunningForPr', () => {
  function wi(prId: number | null, extra: Partial<PipelineState> = {}): PipelineState {
    return {
      workItemId: 1,
      slug: 's',
      startedAt: '',
      updatedAt: '',
      currentStage: 'revision-loop',
      history: [],
      outputs: prId === null ? {} : { draftPr: { id: prId, url: '', branch: '', createdAt: '' } },
      ...extra,
    };
  }

  test('true only for a live WI whose draft PR is this PR', () => {
    expect(wiRunningForPr([wi(7)], 7)).toBe(true);
    expect(wiRunningForPr([wi(8), wi(null)], 7)).toBe(false);
    expect(wiRunningForPr([wi(7, { currentStage: null })], 7)).toBe(false);
    expect(wiRunningForPr([wi(7, { cancelled: true })], 7)).toBe(false);
    expect(wiRunningForPr([wi(7, { terminalError: { stage: 'x', message: 'y', at: '' } as PipelineState['terminalError'] })], 7)).toBe(false);
  });
});
