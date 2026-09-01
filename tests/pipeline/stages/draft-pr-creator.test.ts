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
  capPrDescription,
  MAX_PR_DESCRIPTION_LENGTH,
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
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
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

/** Mirrors the real src/prompts/draft-pr-description.md placeholder set. */
const MINIMAL_TEMPLATE =
  '{{coder-bullets}}{{reviewer-section}}{{test-environment-section}}';

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
    getWorkItemUpdates: mock(async () => []),
    createPullRequestThread: mock(async () => {}),
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
    expect(prCall.title).toBe(sampleWiCtx.title);
    expect(prCall.title).not.toContain('[Agent]');
    expect(prCall.isDraft).toBe(true);
    // The work item reaches the PR via workItemRefs, not by being written into
    // the description — the house style has no WI link line.
    expect(prCall.workItemId).toBe(101);
    expect(prCall.description).toContain(sampleCoder.summary);

    // state.outputs.draftPr is set correctly
    const draftPr = result.outputs.draftPr as DraftPrOutput;
    expect(draftPr.id).toBe(42);
    expect(draftPr.url).toBe('https://dev.azure.com/myorg/my-project/_git/test-repo/pullrequest/42');
    expect(draftPr.branch).toBe(sampleWorktree.branch);
    expect(draftPr.createdAt).toBe('2026-08-14T12:00:00.000Z');
  });

  it('posts a PR comment @-mentioning whoever applied the trigger tag', async () => {
    const ado = makeAdoClient({
      getWorkItemUpdates: mock(async () => [
        {
          revisedBy: { id: 'guid-bob', displayName: 'Bob Jones' },
          fields: { 'System.Tags': { oldValue: 'bug', newValue: 'bug; agent implement' } },
        },
      ]),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: async () => {},
    });

    await stage.execute(makeState(), makeCtx());

    const threadMock = ado.createPullRequestThread as ReturnType<typeof mock>;
    expect(threadMock.mock.calls).toHaveLength(1);
    const arg = threadMock.mock.calls[0]![0] as {
      repositoryName: string;
      pullRequestId: number;
      content: string;
    };
    expect(arg.pullRequestId).toBe(42);
    expect(arg.repositoryName).toBe('test-repo');
    // Markdown token, not the HTML anchor used for work-item comments.
    expect(arg.content).toContain('@<guid-bob>');
    expect(arg.content).not.toContain('data-vss-mention');
  });

  it('skips the PR comment when the tag adder cannot be identified', async () => {
    const ado = makeAdoClient({ getWorkItemUpdates: mock(async () => []) });
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: async () => {},
    });

    await stage.execute(makeState(), makeCtx());
    // A comment nobody is notified by is just noise.
    expect((ado.createPullRequestThread as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  it('a failing notification does not fail the stage — the PR is the deliverable', async () => {
    const ado = makeAdoClient({
      getWorkItemUpdates: mock(async () => [
        {
          revisedBy: { id: 'guid-bob', displayName: 'Bob Jones' },
          fields: { 'System.Tags': { oldValue: '', newValue: 'agent implement' } },
        },
      ]),
      createPullRequestThread: mock(async () => {
        throw new Error('403 forbidden');
      }),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: async () => {},
    });

    const result = await stage.execute(makeState(), makeCtx());
    expect((result.outputs.draftPr as DraftPrOutput).id).toBe(42);
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

    // Change bullets — the coder summary is the fallback when prBullets is absent
    expect(capturedDescription).toContain(sampleCoder.summary);
    // Tests are mentioned, per the house style
    expect(capturedDescription).toContain(sampleTestAuthor.summary);
    // Non-blocking findings surface as review notes
    expect(capturedDescription).toContain('Review notes');
    expect(capturedDescription).toContain(sampleNonBlockingFinding.title);

    // The house style forbids file lists and agent narration in a PR body.
    expect(capturedDescription).not.toContain('src/form.ts');
    expect(capturedDescription).not.toContain('Files changed');
    expect(capturedDescription).not.toContain('Analyzer summary');
    expect(capturedDescription).not.toMatch(/DevopsCoder|Claude|agent/i);
  });

  it('prefers the coder-authored PR bullets over the prose summary', async () => {
    let captured = '';
    const ado = makeAdoClient({
      createPullRequest: mock(async (opts) => {
        captured = opts.description;
        return { id: 1, url: 'u', sourceRefName: '', targetRefName: '' };
      }),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: '{{coder-bullets}}',
      pushBranch: mock(async () => {}),
    });

    const state = makeState({
      outputs: {
        wiContext: sampleWiCtx,
        analyzer: sampleAnalyzer,
        coder: {
          ...sampleCoder,
          prBullets: [
            'Added BACS ID field to the CTS-CB Bank table',
            'Surfaced BACS ID on the Bank Card page for UK bank systems',
          ],
        },
        worktree: sampleWorktree,
      },
    });
    await stage.execute(state, makeCtx());

    expect(captured).toContain('- Added BACS ID field to the CTS-CB Bank table');
    expect(captured).toContain('- Surfaced BACS ID on the Bank Card page for UK bank systems');
    // The prose summary is a fallback only — not both.
    expect(captured).not.toContain(sampleCoder.summary);
  });

  it('uses the coder-authored PR title, falling back to the WI title', async () => {
    const titles: string[] = [];
    const ado = makeAdoClient({
      createPullRequest: mock(async (opts) => {
        titles.push(opts.title);
        return { id: 1, url: 'u', sourceRefName: '', targetRefName: '' };
      }),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig,
      ado,
      prDescriptionTemplate: MINIMAL_TEMPLATE,
      pushBranch: mock(async () => {}),
    });

    await stage.execute(
      makeState({
        outputs: {
          wiContext: sampleWiCtx,
          analyzer: sampleAnalyzer,
          coder: { ...sampleCoder, prTitle: 'Add a dedicated BACS ID to the bank card' },
          worktree: sampleWorktree,
        },
      }),
      makeCtx(),
    );
    // Blank/absent prTitle must not produce an empty PR title.
    await stage.execute(
      makeState({
        outputs: {
          wiContext: sampleWiCtx,
          analyzer: sampleAnalyzer,
          coder: { ...sampleCoder, prTitle: '   ' },
          worktree: sampleWorktree,
        },
      }),
      makeCtx(),
    );

    expect(titles[0]).toBe('Add a dedicated BACS ID to the bank card');
    expect(titles[1]).toBe(sampleWiCtx.title);
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

    // No test-author means no test bullet — and no empty heading left behind.
    expect(capturedDescription).not.toContain(sampleTestAuthor.summary);
    expect(capturedDescription).not.toContain('Test-author');
    // The change bullet is still there.
    expect(capturedDescription).toContain(sampleCoder.summary);
    // The analyzer's readiness verdict is agent narration — it has no place in
    // a PR body under the house style.
    expect(capturedDescription).not.toContain(sampleAnalyzer.summary);
  });

  // -------------------------------------------------------------------------
  // T4 — reviewer note "Approved with no findings." for undefined and no-findings
  // -------------------------------------------------------------------------

  it('T4: renders no review section when there is nothing for a human to look at', () => {
    // A clean approval needs no prose — silence is the good outcome, and the
    // house style has no place for an "Approved with no findings" line.
    const descNoReviewer = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      template: '{{reviewer-section}}',
      config: baseConfig,
    });
    expect(descNoReviewer).toBe('');

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
      template: '{{reviewer-section}}',
      config: baseConfig,
    });
    expect(descApprovedEmpty).toBe('');
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

  // -------------------------------------------------------------------------
  // capPrDescription — 4000-char ADO cap
  // -------------------------------------------------------------------------

  describe('test-environment block', () => {
    const environment = {
      envId: 'env-9',
      name: 'wi-101-fix-login',
      url: 'https://demoportaldev.continiaonline.com/env-9',
      status: 'Running',
      createdAt: 'x',
    };

    function render(overrides: Partial<Parameters<typeof buildPrDescription>[0]> = {}): string {
      return buildPrDescription({
        wiCtx: sampleWiCtx,
        analyzer: sampleAnalyzer,
        coder: sampleCoder,
        testAuthor: undefined,
        reviewer: undefined,
        worktree: sampleWorktree,
        environment,
        template: '{{test-environment-section}}',
        config: baseConfig,
        ...overrides,
      });
    }

    it('matches the format the fw-create-pr skill defines, credentials included', () => {
      const out = render({ environmentUser: { username: 'Rf', password: 'Rf1234!' } });
      expect(out).toContain('---');
      expect(out).toContain('**Test Environment**');
      expect(out).toContain('- Environment: wi-101-fix-login');
      expect(out).toContain('- URL: https://demoportaldev.continiaonline.com/env-9');
      // Without a login a reviewer cannot open the environment and reproduce.
      expect(out).toContain('- Username: Rf');
      expect(out).toContain('- Password: Rf1234!');
    });

    it('omits the credential lines when no login could be read', () => {
      const out = render();
      expect(out).toContain('- Environment: wi-101-fix-login');
      expect(out).toContain('- URL:');
      expect(out).not.toContain('Username');
      expect(out).not.toContain('Password');
    });

    it('omits the password line when the CLI returned a user without one', () => {
      const out = render({ environmentUser: { username: 'Rf' } });
      expect(out).toContain('- Username: Rf');
      expect(out).not.toContain('Password');
    });

    it('renders nothing at all when the pipeline had no environment', () => {
      expect(render({ environment: undefined })).toBe('');
    });

    it('falls back to the env id when the environment has no name', () => {
      const out = render({ environment: { ...environment, name: '' } });
      expect(out).toContain('- Environment: env-9');
    });
  });

  describe('capPrDescription', () => {
    it('leaves short descriptions unchanged', () => {
      expect(capPrDescription('short')).toBe('short');
    });

    it('caps at 4000 chars, drops head content, and preserves the environment section', () => {
      const head = 'H'.repeat(6000);
      const tail = '\n**Test Environment**\n\n- URL: https://bc/env-9\n';
      const capped = capPrDescription(head + tail);
      expect(capped.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
      expect(capped).toContain('**Test Environment**');
      expect(capped).toContain('https://bc/env-9');
      expect(capped).toContain('truncated');
    });

    it('hard-caps when there is no environment section', () => {
      const capped = capPrDescription('X'.repeat(6000));
      expect(capped.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
      expect(capped).toContain('truncated');
    });

    it('anchors on the LAST occurrence when head content echoes the heading', () => {
      const echo = 'Coder noted:\n**Test Environment**\nis documented below.\n';
      const head = echo + 'H'.repeat(6000);
      const tail = '\n**Test Environment**\n\n- URL: https://bc/env-9\n';
      const capped = capPrDescription(head + tail);
      expect(capped.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
      expect(capped).toContain('https://bc/env-9');
      expect(capped).toContain('truncated');
    });
  });

  it('buildPrDescription output never exceeds the ADO limit', () => {
    const desc = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: { ...sampleCoder, summary: 'S'.repeat(6000) },
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      template: '{{coder-bullets}}{{test-environment-section}}',
      environment: { envId: 'env-9', name: 'n', url: 'https://bc/env-9', status: 'Running', createdAt: 'x' },
      config: baseConfig,
    });
    expect(desc.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
    expect(desc).toContain('https://bc/env-9');
  });
});
