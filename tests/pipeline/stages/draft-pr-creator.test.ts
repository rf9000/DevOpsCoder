/**
 * Tests for createDraftPrCreatorStage (Plan 5 task-09).
 *
 * Coverage map:
 *  T1 — happy path: pushBranch called once, createPullRequest called once, state.outputs.draftPr set
 *  T2 — PR description has all sections when all upstream outputs are present
 *  T3 — test-author section is omitted when state.outputs.testAuthor is absent
 *  T4 — reviewer note is "Approved with no findings." when reviewer is undefined or approved with empty findings
 *  T5 — throws on push failure; createPullRequest NOT called
 *  T6 — throws on ADO API failure; state.outputs.draftPr NOT set
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  createDraftPrCreatorStage,
  buildPrDescription,
} from '../../../src/pipeline/stages/draft-pr-creator.ts';
import { AzureDevOpsError } from '../../../src/sdk/azure-devops-client.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type {
  AppConfig,
  CoderOutput,
  DraftPrOutput,
  Finding,
  PipelineState,
  ReviewerOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { AnalyzerOutput } from '../../../src/pipeline/stages/analyzer.ts';
import type { AdoClient } from '../../../src/sdk/azure-devops-client.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: AppConfig = {
  orgUrl: 'https://dev.azure.com/myorg',
  project: 'my project',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false,
};

const sampleWiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login button',
  workItemType: 'Bug',
  state: 'Active',
  description: 'The login button does nothing.',
  reproSteps: '1. Click login\n2. Nothing',
  acceptanceCriteria: 'Button submits form.',
  images: [],
  comments: [],
};

const sampleAnalyzer: AnalyzerOutput = {
  verdict: 'proceed',
  summary: 'Proceed with the login fix.',
  reasons: [],
};

const sampleCoder: CoderOutput = {
  summary: 'Fixed the login button handler.',
  filesChanged: ['src/login.ts', 'src/form.ts'],
  commits: ['deadbeef'],
};

const sampleTestAuthor: TestAuthorOutput = {
  summary: 'Added login button tests.',
  testFilesChanged: ['tests/login.test.ts'],
  commits: ['cafebabe'],
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

const sampleNonBlockingFinding: Finding = {
  severity: 'minor',
  file: 'src/login.ts',
  line: 42,
  title: 'Missing null check',
  description: 'Should check for null.',
  axis: 'safety-correctness',
};

const sampleReviewerApprovedWithFinding: ReviewerOutput = {
  approved: true,
  findings: [sampleNonBlockingFinding],
  attempts: 1,
};

const MINIMAL_TEMPLATE =
  '[#{{wi-id}}: {{wi-title}}]({{wi-url}})\n{{analyzer-summary}}\n{{coder-summary}}\n{{coder-files-changed}}\n{{test-author-section}}\n{{reviewer-note}}\n{{branch}}\n{{base-sha}}';

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'draft-pr-creator',
    history: [],
    outputs: {
      wiContext: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: sampleTestAuthor,
      reviewer: sampleReviewerApprovedWithFinding,
      worktree: sampleWorktree,
    },
    ...overrides,
  };
}

function makeCtx() {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  };
}

/** Build a minimal AdoClient mock with createPullRequest returning a PR. */
function makeAdoClient(overrides: Partial<AdoClient> = {}): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => []),
    getWorkItem: mock(async () => ({ id: 101, fields: {} })),
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({
      id: 42,
      url: 'https://dev.azure.com/myorg/my-project/_git/test-repo/pullrequest/42',
      sourceRefName: 'refs/heads/agent/wi-101-fix-login',
      targetRefName: 'refs/heads/main',
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T1 — happy path
// ---------------------------------------------------------------------------

describe('createDraftPrCreatorStage', () => {
  it('T1: pushes branch and opens PR (happy path)', async () => {
    const pushBranch = mock(async (_branch: string, _cwd: string) => {});
    const ado = makeAdoClient();
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch,
    });

    const state = makeState();
    const result = await stage.execute(state, makeCtx());

    // pushBranch called once with correct args
    expect(pushBranch.mock.calls).toHaveLength(1);
    const pushCall = pushBranch.mock.calls[0]!;
    expect(pushCall[0]).toBe(sampleWorktree.branch);
    expect(pushCall[1]).toBe(sampleWorktree.path);

    // createPullRequest called once with correct args
    expect((ado.createPullRequest as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const prCall = (ado.createPullRequest as ReturnType<typeof mock>).mock.calls[0]![0] as {
      repositoryName: string;
      sourceRefName: string;
      targetRefName: string;
      title: string;
      description: string;
      isDraft: boolean;
      workItemId: number;
    };
    expect(prCall.repositoryName).toBe('test-repo');
    expect(prCall.sourceRefName).toBe(`refs/heads/${sampleWorktree.branch}`);
    expect(prCall.targetRefName).toBe('refs/heads/main');
    expect(prCall.title).toBe(`[Agent] ${sampleWiCtx.title}`);
    expect(prCall.isDraft).toBe(true);
    expect(prCall.description).toContain('101');
    expect(prCall.workItemId).toBe(101);

    // state.outputs.draftPr is set correctly
    const draftPr = result.outputs.draftPr as DraftPrOutput;
    expect(draftPr.id).toBe(42);
    expect(draftPr.url).toBe('https://dev.azure.com/myorg/my-project/_git/test-repo/pullrequest/42');
    expect(draftPr.branch).toBe(sampleWorktree.branch);
    expect(draftPr.createdAt).toBe('2026-08-14T12:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // T2 — PR description has all sections
  // -------------------------------------------------------------------------

  it('T2: PR description has all sections when all upstream outputs are present', async () => {
    let capturedDescription = '';
    const ado = makeAdoClient({
      createPullRequest: mock(async (opts) => {
        capturedDescription = opts.description;
        return {
          id: 99,
          url: 'https://x/pr/99',
          sourceRefName: opts.sourceRefName,
          targetRefName: opts.targetRefName,
        };
      }),
    });

    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: mock(async () => {}),
    });

    // State with a full reviewer having 1 non-blocking finding
    const state = makeState({
      outputs: {
        wiContext: sampleWiCtx,
        analyzer: sampleAnalyzer,
        coder: sampleCoder,
        testAuthor: sampleTestAuthor,
        reviewer: sampleReviewerApprovedWithFinding,
        worktree: sampleWorktree,
      },
    });

    await stage.execute(state, makeCtx());

    // WI link
    expect(capturedDescription).toContain(String(sampleWiCtx.id));
    expect(capturedDescription).toContain(sampleWiCtx.title);
    // Analyzer summary
    expect(capturedDescription).toContain(sampleAnalyzer.summary);
    // Coder summary
    expect(capturedDescription).toContain(sampleCoder.summary);
    // Coder files
    expect(capturedDescription).toContain('src/login.ts');
    expect(capturedDescription).toContain('src/form.ts');
    // Test-author summary
    expect(capturedDescription).toContain(sampleTestAuthor.summary);
    // Reviewer note: approved with 1 non-blocking finding
    expect(capturedDescription).toContain('Approved with 1 non-blocking findings:');
    expect(capturedDescription).toContain(sampleNonBlockingFinding.title);
  });

  // -------------------------------------------------------------------------
  // T3 — test-author section omitted when testAuthor is absent
  // -------------------------------------------------------------------------

  it('T3: test-author section omitted when testAuthor output is absent', async () => {
    let capturedDescription = '';
    const ado = makeAdoClient({
      createPullRequest: mock(async (opts) => {
        capturedDescription = opts.description;
        return {
          id: 77,
          url: 'https://x/pr/77',
          sourceRefName: opts.sourceRefName,
          targetRefName: opts.targetRefName,
        };
      }),
    });

    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: mock(async () => {}),
    });

    // State WITHOUT testAuthor
    const state = makeState({
      outputs: {
        wiContext: sampleWiCtx,
        analyzer: sampleAnalyzer,
        coder: sampleCoder,
        worktree: sampleWorktree,
        // testAuthor deliberately absent
      },
    });

    await stage.execute(state, makeCtx());

    expect(capturedDescription).not.toContain('## Test-author summary');
    // Other sections still present
    expect(capturedDescription).toContain(sampleAnalyzer.summary);
    expect(capturedDescription).toContain(sampleCoder.summary);
  });

  // -------------------------------------------------------------------------
  // T4 — reviewer note "Approved with no findings." for undefined and no-findings
  // -------------------------------------------------------------------------

  it('T4: reviewer note is "Approved with no findings." when reviewer is undefined or approved with empty findings', () => {
    // Sub-case A: reviewer undefined
    const descNoReviewer = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      template: '{{reviewer-note}}',
      config: baseConfig,
    });
    expect(descNoReviewer).toBe('Approved with no findings.');

    // Sub-case B: reviewer approved with empty findings array
    const reviewerApprovedNoFindings: ReviewerOutput = {
      approved: true,
      findings: [],
      attempts: 1,
    };
    const descApprovedEmpty = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      reviewer: reviewerApprovedNoFindings,
      worktree: sampleWorktree,
      template: '{{reviewer-note}}',
      config: baseConfig,
    });
    expect(descApprovedEmpty).toBe('Approved with no findings.');
  });

  it('substitutes {{environment-id}} and {{environment-url}} when the env output is present', () => {
    const desc = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      environment: {
        envId: 'env-9',
        name: 'wi-101-fix-login',
        url: 'https://bc/env-9',
        status: 'Running',
        createdAt: '2026-07-07T10:00:00Z',
      },
      template: '{{environment-id}} | {{environment-url}}',
      config: baseConfig,
    });
    expect(desc).toBe('env-9 | https://bc/env-9');
  });

  it('falls back to placeholders text when the env output is missing', () => {
    const desc = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      template: '{{environment-id}} | {{environment-url}}',
      config: baseConfig,
    });
    expect(desc).toBe('(none) | (not available)');
  });

  // -------------------------------------------------------------------------
  // T5 — throws on push failure; createPullRequest NOT called
  // -------------------------------------------------------------------------

  it('T5: throws on push failure; createPullRequest is NOT called', async () => {
    const ado = makeAdoClient();
    const pushError = new Error('remote: Permission denied');
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: mock(async () => {
        throw pushError;
      }),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      'remote: Permission denied',
    );

    expect((ado.createPullRequest as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T6 — throws on ADO API failure; state.outputs.draftPr NOT set
  // -------------------------------------------------------------------------

  it('T6: throws on ADO API failure; state.outputs.draftPr is NOT set', async () => {
    const ado = makeAdoClient({
      createPullRequest: mock(async () => {
        throw new AzureDevOpsError('Conflict: a PR already exists', 409);
      }),
    });

    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: mock(async () => {}),
    });

    const state = makeState();
    await expect(stage.execute(state, makeCtx())).rejects.toThrow(
      'Conflict: a PR already exists',
    );

    expect(state.outputs.draftPr).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Signal forwarding
  // -------------------------------------------------------------------------

  it('forwards the pipeline abort signal to createPullRequest', async () => {
    let capturedOpts: { signal?: AbortSignal } | undefined;
    const ado = makeAdoClient({
      createPullRequest: mock(async (_args, opts) => {
        capturedOpts = opts;
        return { id: 1, url: 'https://x/pr/1', sourceRefName: 's', targetRefName: 't' };
      }),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig, ado, prDescriptionTemplate: MINIMAL_TEMPLATE, pushBranch: mock(async () => {}),
    });
    const ctx = makeCtx();
    await stage.execute(makeState(), ctx);
    expect(capturedOpts?.signal).toBe(ctx.signal);
  });
});
