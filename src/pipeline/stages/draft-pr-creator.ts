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
import { buildGitAuthArgs, redactPat } from '../../utils/git-auth.ts';
import { findTagAdder, formatAdoMentionMarkdown } from '../../utils/tag-history.ts';

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

async function defaultPushBranch(branch: string, cwd: string, pat: string): Promise<void> {
  // --force-with-lease: agent/wi-* branches are agent-owned; the fix loop's
  // reset path can rewrite history, and a plain push then dies non-fast-forward
  // on re-entry. Auth is per-invocation extraHeader — the origin URL stays
  // credential-free (see README "Push auth").
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      ['git', ...buildGitAuthArgs(pat), 'push', '--force-with-lease', 'origin', branch],
      {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      },
    );
  } catch (spawnErr) {
    // Bun.spawn throws (e.g. ENOENT) synchronously when cwd is invalid or git not found.
    const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    throw new Error(`git push origin ${branch} failed (spawn error): ${redactPat(msg, pat)}`);
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(
      `git push origin ${branch} failed (exit ${exitCode}): ${redactPat(stderr.trim(), pat)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// PR description length cap (ADO rejects descriptions over 4000 chars)
// ---------------------------------------------------------------------------

/** ADO rejects PR descriptions over 4000 chars with a 400 (seen on a real WI). */
export const MAX_PR_DESCRIPTION_LENGTH = 4000;
const TRUNCATION_NOTICE = '\n\n_(earlier sections truncated to fit ADO’s 4000-char description limit)_\n';
const TAIL_MARKER = '\n## Test environment';

/**
 * Cap the rendered description. Truncation sacrifices the head (summaries) and
 * preserves everything from the "## Test environment" heading down — the env
 * URL is the part a human tester cannot reconstruct.
 */
export function capPrDescription(full: string): string {
  if (full.length <= MAX_PR_DESCRIPTION_LENGTH) return full;
  // lastIndexOf: agent-authored head content (coder summary, reviewer notes)
  // can echo the literal heading text, so anchoring on the first occurrence
  // would treat nearly the whole document as "tail" and starve headBudget.
  // The real env section — the one we must preserve — is always the last one.
  const idx = full.lastIndexOf(TAIL_MARKER);
  if (idx === -1) {
    return full.slice(0, MAX_PR_DESCRIPTION_LENGTH - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  }
  const tail = full.slice(idx);
  const headBudget = MAX_PR_DESCRIPTION_LENGTH - tail.length - TRUNCATION_NOTICE.length;
  const capped = full.slice(0, Math.max(0, headBudget)) + TRUNCATION_NOTICE + tail;
  // Degenerate case: the tail plus the notice alone exceed the limit — hard
  // cap, better a clipped footer than a 400 from ADO.
  return capped.length <= MAX_PR_DESCRIPTION_LENGTH ? capped : capped.slice(0, MAX_PR_DESCRIPTION_LENGTH);
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
  return capPrDescription(result);
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
      const push = deps.pushBranch ?? ((b: string, cwd: string) => defaultPushBranch(b, cwd, deps.config.pat));

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
          // Plain WI title — no "[Agent]" prefix. The PR is already identifiable
          // as agent-authored: it opens as a draft, is linked to the WI via
          // workItemRefs, and the description carries the agent's summary.
          title: wiCtx.title,
          description: prDescription,
          isDraft: true,
          workItemId: wiCtx.id,
        },
        { signal: ctx.signal },
      );

      // 4. Notify whoever asked for the work, as a PR comment thread.
      // Best-effort and deliberately after the PR exists: the PR is the
      // deliverable, and neither the identity lookup nor the thread post is
      // worth failing a successful run over. Failures are logged, not thrown.
      try {
        const updates = await deps.ado.getWorkItemUpdates(wiCtx.id, { signal: ctx.signal });
        const adder = findTagAdder(updates, deps.config.triggerTag);
        const mention = adder ? formatAdoMentionMarkdown(adder.identity) : '';
        // No GUID means nothing for ADO to resolve — a comment nobody is
        // notified by is just noise, so skip it entirely.
        if (mention) {
          await deps.ado.createPullRequestThread(
            {
              repositoryName: deps.config.repositoryName,
              pullRequestId: prResult.id,
              content: `${mention} Draft PR ready for #${wiCtx.id}.`,
            },
            { signal: ctx.signal },
          );
        }
      } catch (err) {
        ctx.logger.info(
          `WI ${wiCtx.id}: draft PR opened but the notification comment failed :: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 5. Store output
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
