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
import { pickAdminUser, type ContiniaCli } from '../../services/continia-cli.ts';

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
  /**
   * Used only to read the environment login for the description's Test
   * Environment block. Optional: without it the block omits credentials.
   */
  continiaCli?: ContiniaCli;
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
const TAIL_MARKER = '\n**Test Environment**';

/**
 * Cap the rendered description. Truncation sacrifices the head (summaries) and
 * preserves everything from the "**Test Environment**" heading down — the env
 * URL and credentials are the part a human tester cannot reconstruct.
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

/** One bullet line. Strips a leading marker the model was told to omit. */
function bullet(text: string): string {
  return `- ${text.trim().replace(/^[-*]\s+/, '')}`;
}

export function buildPrDescription(args: {
  wiCtx: WorkItemContext;
  analyzer: AnalyzerOutput;
  coder: CoderOutput;
  testAuthor: TestAuthorOutput | undefined;
  reviewer: ReviewerOutput | undefined;
  worktree: WorktreeContext;
  /** The per-WI BC environment the verification ran on (defensive-optional). */
  environment?: EnvironmentOutput;
  /**
   * Login for that environment, fetched at PR-creation time. Never sourced from
   * pipeline state — credentials are deliberately not persisted.
   */
  environmentUser?: { username: string; password?: string };
  template: string;
  config: AppConfig;
}): string {
  const { wiCtx, analyzer, coder, testAuthor, reviewer, worktree, environment, template, config } =
    args;

  // Change bullets in the team's house style. prBullets is what the coder is
  // asked for; the prose summary is the fallback when a model omits them.
  const changeBullets: string[] = [];
  if (coder.prBullets && coder.prBullets.length > 0) {
    changeBullets.push(...coder.prBullets.map(bullet));
  } else if (coder.summary.trim().length > 0) {
    changeBullets.push(bullet(coder.summary));
  }
  // The convention asks for tests to be mentioned. The coder cannot do it —
  // test-author runs after it.
  if (testAuthor !== undefined && testAuthor.summary.trim().length > 0) {
    changeBullets.push(bullet(testAuthor.summary));
  }
  const coderBullets =
    changeBullets.length > 0 ? changeBullets.join('\n') : bullet('No changes reported.');

  // Findings only when a human should look at something. An approval with no
  // findings needs no section — silence is the good outcome.
  let reviewerSection = '';
  if (reviewer !== undefined && reviewer.findings.length > 0) {
    const heading = reviewer.approved
      ? `**Review notes** (${reviewer.findings.length} non-blocking)`
      : `**Review notes** (${reviewer.findings.length} unresolved — reviewer did not approve)`;
    const list = reviewer.findings
      .map((f) => {
        const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
        return `- ${f.severity} — ${loc}: ${f.title}`;
      })
      .join('\n');
    reviewerSection = `\n${heading}\n\n${list}\n`;
  }

  // Test-environment block in the exact shape the `fw-create-pr` skill defines,
  // so a DevopsCoder PR reads like a hand-made one. Username and password are
  // included deliberately: without them a reviewer cannot log in and reproduce
  // the change. These are short-lived DemoPortal sandbox logins, and an
  // API-delivered PR description is the sanctioned channel for them — they
  // never reach a commit message, a work item, the state file, or a log line.
  let testEnvironmentSection = '';
  if (environment !== undefined) {
    const lines = ['\n---\n', '**Test Environment**', ''];
    lines.push(`- Environment: ${environment.name || environment.envId}`);
    if (environment.url) lines.push(`- URL: ${environment.url}`);
    if (args.environmentUser?.username) {
      lines.push(`- Username: ${args.environmentUser.username}`);
      if (args.environmentUser.password) {
        lines.push(`- Password: ${args.environmentUser.password}`);
      }
    }
    lines.push('');
    lines.push('_The environment auto-deletes ~10 days after creation._');
    testEnvironmentSection = lines.join('\n');
  }

  const wiUrl = `${config.orgUrl}/${encodeURIComponent(config.project)}/_workitems/edit/${wiCtx.id}`;

  const substitutions: Record<string, string> = {
    '{{coder-bullets}}': coderBullets,
    '{{reviewer-section}}': reviewerSection,
    '{{test-environment-section}}': testEnvironmentSection,
    // Retained so an older or custom template still renders.
    '{{wi-id}}': String(wiCtx.id),
    '{{wi-title}}': wiCtx.title,
    '{{wi-url}}': wiUrl,
    '{{analyzer-summary}}': analyzer.summary,
    '{{coder-summary}}': coder.summary,
    '{{branch}}': worktree.branch,
    '{{base-sha}}': worktree.baseSha,
    '{{environment-id}}': environment?.envId ?? '(none)',
    '{{environment-url}}': environment?.url ?? '(not available)',
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(substitutions)) {
    result = result.replaceAll(placeholder, value);
  }
  // Drop the maintainer comment the template carries at the top.
  result = result.replace(/^<!--[\s\S]*?-->\s*/, '');
  return capPrDescription(result.trim());
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

      // 2. Environment login for the description's Test Environment block.
      // Fetched here, at PR time, and never written to state: credentials must
      // not land in .state/<id>.json. Best-effort — a PR without credentials is
      // still a PR, so a CLI failure degrades to name + URL only.
      let environmentUser: { username: string; password?: string } | undefined;
      if (environment !== undefined && deps.continiaCli !== undefined) {
        try {
          const users = await deps.continiaCli.getEnvironmentUsers(environment.envId, {
            worktreePath: worktree.path,
            signal: ctx.signal,
          });
          const picked = pickAdminUser(users);
          if (picked) {
            environmentUser = picked.password !== undefined
              ? { username: picked.username, password: picked.password }
              : { username: picked.username };
          }
        } catch (err) {
          // Never log the error body — a CLI failure can echo its own stdout,
          // and that stdout may contain the plaintext passwords.
          ctx.logger.info(
            `WI ${wiCtx.id}: could not read environment logins for the PR description (${err instanceof Error ? err.name : 'error'})`,
          );
        }
      }

      // 3. Build PR description
      const prDescription = buildPrDescription({
        wiCtx,
        analyzer,
        coder,
        testAuthor,
        reviewer,
        worktree,
        environment,
        ...(environmentUser ? { environmentUser } : {}),
        template: deps.prDescriptionTemplate,
        config: deps.config,
      });

      // 4. Create the PR — let AzureDevOpsError propagate; its message already
      // carries the URL, status, and ADO response body.
      const prResult = await deps.ado.createPullRequest(
        {
          repositoryName: deps.config.repositoryName,
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: 'refs/heads/main',
          // The coder writes the title in the team's house style (imperative,
          // business outcome, 50-70 chars). The WI title is the fallback: it is
          // a request ("Handling of BACS payments"), not a change description.
          // No "[Agent]" prefix — the PR opens as a draft and is WI-linked.
          title: coder.prTitle?.trim() || wiCtx.title,
          description: prDescription,
          isDraft: true,
          workItemId: wiCtx.id,
        },
        { signal: ctx.signal },
      );

      // 5. Notify whoever asked for the work, as a PR comment thread.
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

      // 6. Store output
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
