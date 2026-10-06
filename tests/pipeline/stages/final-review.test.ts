import { describe, it, expect, mock } from 'bun:test';
import { createFinalReviewStage, parseShortstatLines } from '../../../src/pipeline/stages/final-review.ts';
import type { Stage, PipelineContext } from '../../../src/pipeline/stage.ts';
import {
  CostExceededError,
  type AppConfig,
  type FinalReviewOutput,
  type Finding,
  type PipelineState,
  type ReviewerOutput,
  type WorktreeContext,
} from '../../../src/types/index.ts';

const worktree: WorktreeContext = { path: '/w/wi-1', branch: 'agent/wi-1', baseSha: 'base' };

const config: AppConfig = {
  orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/r', worktreeBase: '/w',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, reviewerMaxTurns: 50, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 50, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', logDir: 'logs', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: '', continiaEnvLocalization: 'base',
  continiaApiToken: 'tok', continiaAppPaths: [], continiaTestAppPaths: [], maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all',
  maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
  finalReviewMinLines: 300,
};

const blocker: Finding = {
  severity: 'blocking', file: 'Auth.al', line: 199, title: 'Wipes shared storage',
  description: 'd', axis: 'safety-correctness',
};
const minor: Finding = { severity: 'minor', file: 'B.al', title: 'Name', description: 'd', axis: 'naming-style' };

function ctx(cfg: AppConfig = config): PipelineContext {
  return {
    config: cfg,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-10-06T00:00:00Z'),
  } as unknown as PipelineContext;
}

function state(): PipelineState {
  const loopReview: ReviewerOutput = { approved: true, findings: [minor], attempts: 2, byAxis: {} };
  return {
    workItemId: 1, slug: 'wi-1', startedAt: '', updatedAt: '', currentStage: null, history: [],
    outputs: {
      worktree,
      reviewer: loopReview,
      findingsAddressed: [{ file: 'B.al', action: 'fixed', reason: 'r' }],
      coder: { summary: 'loop', filesChanged: ['A.al'], commits: ['c1'] },
      verification: { attempts: 0, compiled: true, deploy: [], testRuns: [], passed: true },
    },
  };
}

function reviewerReturning(findings: Finding[], seen?: { reviewer?: unknown; addressed?: unknown }): Stage {
  return {
    name: 'final-review',
    canRun: () => true,
    execute: mock(async (s: PipelineState) => {
      if (seen) {
        seen.reviewer = s.outputs.reviewer;
        seen.addressed = s.outputs.findingsAddressed;
      }
      s.outputs.reviewer = {
        approved: !findings.some((f) => f.severity === 'blocking' || f.severity === 'critical'),
        findings, attempts: 1, byAxis: {},
      } satisfies ReviewerOutput;
      return s;
    }),
  };
}

function stage(execute: (s: PipelineState) => Promise<PipelineState>, name: string): Stage {
  return { name, canRun: () => true, execute: mock(execute) };
}

const fixOk = (seen?: { findings?: Finding[] }) =>
  stage(async (s) => {
    seen && (seen.findings = (s.outputs.reviewer as ReviewerOutput).findings);
    s.outputs.coder = { summary: 'fixed', filesChanged: ['Auth.al'], commits: ['c2'] };
    s.outputs.findingsAddressed = [{ file: 'Auth.al', line: 199, action: 'fixed', reason: 'scoped to company' }];
    return s;
  }, 'fix-findings');

describe('parseShortstatLines', () => {
  it('sums insertions and deletions', () => {
    expect(parseShortstatLines(' 3 files changed, 120 insertions(+), 4 deletions(-)\n')).toBe(124);
    expect(parseShortstatLines(' 1 file changed, 1 insertion(+)')).toBe(1);
    expect(parseShortstatLines('')).toBe(0);
  });
});

describe('createFinalReviewStage', () => {
  it('records a skip and calls nothing when disabled', async () => {
    const reviewer = reviewerReturning([blocker]);
    const s = await createFinalReviewStage({
      config: { ...config, finalReviewMinLines: undefined },
      reviewer, fixFindings: fixOk(), getDiffLines: async () => 5000,
    }).execute(state(), ctx());
    expect((s.outputs.finalReview as FinalReviewOutput).ran).toBe(false);
    expect(reviewer.execute).not.toHaveBeenCalled();
  });

  it('skips a diff below the threshold', async () => {
    const reviewer = reviewerReturning([blocker]);
    const s = await createFinalReviewStage({
      config, reviewer, fixFindings: fixOk(), getDiffLines: async () => 120,
    }).execute(state(), ctx());
    const out = s.outputs.finalReview as FinalReviewOutput;
    expect(out.ran).toBe(false);
    expect(out.diffLines).toBe(120);
    expect(reviewer.execute).not.toHaveBeenCalled();
  });

  it('reviews cold and restores the loop review state afterwards', async () => {
    const seen: { reviewer?: unknown; addressed?: unknown } = {};
    const before = state();
    const loopReview = before.outputs.reviewer;
    const s = await createFinalReviewStage({
      config, reviewer: reviewerReturning([minor], seen), fixFindings: fixOk(), getDiffLines: async () => 400,
    }).execute(before, ctx());
    expect(seen.reviewer).toBeUndefined();
    expect(seen.addressed).toBeUndefined();
    expect(s.outputs.reviewer).toBe(loopReview);
    const out = s.outputs.finalReview as FinalReviewOutput;
    expect(out).toMatchObject({ ran: true, diffLines: 400, fix: 'none' });
    expect(out.findings).toEqual([minor]);
  });

  it('fixes only the blockers, re-verifies, and reports verified', async () => {
    const seen: { findings?: Finding[] } = {};
    const buildAndTest = stage(async (s) => s, 'build-and-test');
    const s = await createFinalReviewStage({
      config, reviewer: reviewerReturning([blocker, minor]), fixFindings: fixOk(seen), buildAndTest,
      getDiffLines: async () => 400, getCurrentHeadSha: async () => 'green', resetWorktree: async () => {},
    }).execute(state(), ctx());
    expect(seen.findings).toEqual([blocker]);
    expect(buildAndTest.execute).toHaveBeenCalledTimes(1);
    const out = s.outputs.finalReview as FinalReviewOutput;
    expect(out.fix).toBe('verified');
    expect(out.findingsAddressed?.[0]?.action).toBe('fixed');
    expect((s.outputs.reviewer as ReviewerOutput).attempts).toBe(2);
    expect((s.outputs.coder as { summary: string }).summary).toBe('fixed');
  });

  it('reverts to the verified commit and re-runs the gate when the fix breaks it', async () => {
    const reset = mock(async (_p: string, _sha: string) => {});
    let gateRuns = 0;
    const buildAndTest = stage(async (s) => {
      gateRuns += 1;
      if (gateRuns === 1) throw new Error('verification failed: 2 failing test(s)');
      return s;
    }, 'build-and-test');
    const before = state();
    const verifiedCoder = before.outputs.coder;
    const s = await createFinalReviewStage({
      config, reviewer: reviewerReturning([blocker]), fixFindings: fixOk(), buildAndTest,
      getDiffLines: async () => 400, getCurrentHeadSha: async () => 'green', resetWorktree: reset,
    }).execute(before, ctx());
    expect(reset).toHaveBeenCalledWith('/w/wi-1', 'green');
    expect(gateRuns).toBe(2);
    expect(s.outputs.coder).toBe(verifiedCoder);
    const out = s.outputs.finalReview as FinalReviewOutput;
    expect(out.fix).toBe('reverted');
    expect(out.fixError).toContain('verification failed');
  });

  it('does not attempt a fix without a verification gate', async () => {
    const fix = fixOk();
    const s = await createFinalReviewStage({
      config, reviewer: reviewerReturning([blocker]), fixFindings: fix, getDiffLines: async () => 400,
    }).execute(state(), ctx());
    expect(fix.execute).not.toHaveBeenCalled();
    expect((s.outputs.finalReview as FinalReviewOutput).fix).toBe('skipped');
  });

  it('records a skip when the review itself fails, but rethrows the cost cap', async () => {
    const failing = stage(async () => { throw new Error('axis failed'); }, 'final-review');
    const s = await createFinalReviewStage({
      config, reviewer: failing, fixFindings: fixOk(), getDiffLines: async () => 400,
    }).execute(state(), ctx());
    expect((s.outputs.finalReview as FinalReviewOutput).skipReason).toContain('axis failed');
    expect(s.outputs.reviewer).toBeDefined();

    const capped = stage(async () => { throw new CostExceededError(60, 50, 'final-review'); }, 'final-review');
    await expect(
      createFinalReviewStage({ config, reviewer: capped, fixFindings: fixOk(), getDiffLines: async () => 400 })
        .execute(state(), ctx()),
    ).rejects.toBeInstanceOf(CostExceededError);
  });
});
