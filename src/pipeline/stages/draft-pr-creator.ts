import type { Stage } from '../stage.ts';
import type {
  AppConfig,
  CoderOutput,
  DraftPrOutput,
  EnvironmentOutput,
  TestAuthorOutput,
  WorktreeContext,
  ReviewerOutput,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { AdoClient } from '../../sdk/azure-devops-client.ts';
import type { AnalyzerOutput } from './analyzer.ts';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface DraftPrCreatorStageDeps {
  config: AppConfig;
  ado: AdoClient;
  /** Contents of src/prompts/draft-pr-description.md. */
  prDescriptionTemplate: string;
  /** Test override for `git push origin <branch>` (production default uses Bun.spawn). */
  pushBranch?: (branch: string, cwd: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default push implementation (Bun.spawn git push)
// ---------------------------------------------------------------------------

async function defaultPushBranch(branch: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', 'push', 'origin', branch], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`git push origin ${branch} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// PR description builder (exported for testability)
// ---------------------------------------------------------------------------

export function buildPrDescription(args: {
  wiCtx: WorkItemContext;
  analyzer: AnalyzerOutput;
  coder: CoderOutput;
  testAuthor: TestAuthorOutput | undefined;
  reviewer: ReviewerOutput | undefined;
  worktree: WorktreeContext;
  /** The per-WI BC environment the verification ran on (defensive-optional). */
  environment?: EnvironmentOutput;
  template: string;
  config: AppConfig;
}): string {
  const { wiCtx, analyzer, coder, testAuthor, reviewer, worktree, environment, template, config } = args;

  // Build the WI URL
  const wiUrl = `${config.orgUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${wiCtx.id}`;

  // Build coder files changed
  const coderFilesChanged =
    coder.filesChanged.length > 0
      ? coder.filesChanged.map((f) => `- ${f}`).join('\n')
      : '(no files reported)';

  // Build test-author section
  let testAuthorSection = '';
  if (testAuthor !== undefined) {
    const testFilesList =
      testAuthor.testFilesChanged.length > 0
        ? testAuthor.testFilesChanged.map((f) => `- ${f}`).join('\n')
        : '(no test files reported)';
    testAuthorSection = [
      '## Test-author summary',
      '',
      testAuthor.summary,
      '',
      '**Test files changed:**',
      '',
      testFilesList,
    ].join('\n');
  }

  // Build reviewer note
  let reviewerNote: string;
  if (reviewer === undefined || (reviewer.approved === true && reviewer.findings.length === 0)) {
    reviewerNote = 'Approved with no findings.';
  } else if (reviewer.approved === true && reviewer.findings.length > 0) {
    const N = reviewer.findings.length;
    const list = reviewer.findings
      .map((f) => `- **${f.file}${f.line !== undefined ? `:${f.line}` : ''}** (${f.severity}): ${f.title}`)
      .join('\n');
    reviewerNote = `Approved with ${N} non-blocking findings:\n\n${list}`;
  } else {
    // reviewer.approved === false — defensive rendering
    const N = reviewer.findings.length;
    const list = reviewer.findings
      .map((f) => `- **${f.file}${f.line !== undefined ? `:${f.line}` : ''}** (${f.severity}): ${f.title}`)
      .join('\n');
    reviewerNote = `Reviewer did NOT approve. ${N} findings remain:\n\n${list}`;
  }

  const substitutions: Record<string, string> = {
    '{{wi-id}}': String(wiCtx.id),
    '{{wi-title}}': wiCtx.title,
    '{{wi-url}}': wiUrl,
    '{{analyzer-summary}}': analyzer.summary,
    '{{coder-summary}}': coder.summary,
    '{{coder-files-changed}}': coderFilesChanged,
    '{{test-author-section}}': testAuthorSection,
    '{{reviewer-note}}': reviewerNote,
    '{{branch}}': worktree.branch,
    '{{base-sha}}': worktree.baseSha,
    '{{environment-id}}': environment?.envId ?? '(none)',
    '{{environment-url}}': environment?.url ?? '(not available)',
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(substitutions)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage factory
// ---------------------------------------------------------------------------

export function createDraftPrCreatorStage(deps: DraftPrCreatorStageDeps): Stage {
  return {
    name: 'draft-pr-creator',
    canRun: () => true,
    async execute(state, ctx) {
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const analyzer = state.outputs.analyzer as AnalyzerOutput | undefined;
      const coder = state.outputs.coder as CoderOutput | undefined;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      const testAuthor = state.outputs.testAuthor as TestAuthorOutput | undefined;
      const reviewer = state.outputs.reviewer as ReviewerOutput | undefined;
      const environment = state.outputs.environment as EnvironmentOutput | undefined;

      if (!wiCtx) throw new Error('draft-pr-creator requires state.outputs.wiContext to be populated');
      if (!analyzer) throw new Error('draft-pr-creator requires state.outputs.analyzer to be populated');
      if (!coder) throw new Error('draft-pr-creator requires state.outputs.coder to be populated');
      if (!worktree) throw new Error('draft-pr-creator requires state.outputs.worktree to be populated');

      const branch = worktree.branch;
      const push = deps.pushBranch ?? defaultPushBranch;

      // 1. Push branch — let the underlying push error propagate; the orchestrator
      // logs the stage name, so the original error message is already actionable.
      await push(branch, worktree.path);

      // 2. Build PR description
      const prDescription = buildPrDescription({
        wiCtx,
        analyzer,
        coder,
        testAuthor,
        reviewer,
        worktree,
        environment,
        template: deps.prDescriptionTemplate,
        config: deps.config,
      });

      // 3. Create the PR — let AzureDevOpsError propagate; its message already
      // carries the URL, status, and ADO response body.
      const prResult = await deps.ado.createPullRequest(
        {
          repositoryName: deps.config.repositoryName,
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: 'refs/heads/main',
          title: `[Agent] ${wiCtx.title}`,
          description: prDescription,
          isDraft: true,
          workItemId: wiCtx.id,
        },
        { signal: ctx.signal },
      );

      // 4. Store output
      const output: DraftPrOutput = {
        id: prResult.id,
        url: prResult.url,
        branch,
        createdAt: ctx.now().toISOString(),
      };
      state.outputs.draftPr = output;
      return state;
    },
  };
}
