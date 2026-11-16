import type { EnvironmentOutput, PullRequestDetails, VerificationOutput } from '../types/index.ts';
import type { PrFixOutcome, RebaseOutput } from './types.ts';

const sha7 = (sha: string): string => sha.slice(0, 7);
const branch = (ref: string): string => ref.replace(/^refs\/heads\//, '');

/** Error text in a comment is capped; the full text is in the run's log and JSON outcome. */
export const MAX_COMMENT_ERROR_LENGTH = 2000;

/**
 * One line of model- or git-supplied text. A newline in a commit subject, a
 * resolver's `resolution` or an error would otherwise start a new markdown
 * block (a heading, a list item) in the comment.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function conflictLines(conflicts: RebaseOutput['conflicts']): string[] {
  const lines: string[] = [];
  for (const c of conflicts) {
    lines.push(`- \`${sha7(c.commit)}\` ${oneLine(c.subject)}`);
    for (const path of c.files) {
      const resolution = c.resolutions.find((r) => r.path === path)?.resolution;
      lines.push(resolution ? `  - \`${path}\`: ${oneLine(resolution)}` : `  - \`${path}\``);
    }
  }
  return lines;
}

function verificationLines(a: {
  verification?: VerificationOutput;
  environment?: EnvironmentOutput;
  skippedVerification: boolean;
  keepEnv: boolean;
}): string[] {
  const lines: string[] = [];
  if (a.skippedVerification) {
    lines.push('**Not verified** (SKIP_BUILD_TEST)');
    return lines;
  }
  const v = a.verification;
  if (!v) {
    lines.push('**Not verified** (no verification result recorded)');
  } else if (v.skipped) {
    lines.push(`**Not verified**: ${v.skipReason ?? 'verification was skipped'}`);
  } else {
    const total = v.testRuns.reduce((n, t) => n + t.summary.total, 0);
    const failed = v.testRuns.reduce((n, t) => n + t.summary.failed, 0);
    lines.push(
      v.passed
        ? `Verification passed: compiled and deployed, ${total} test(s) run, 0 failed.`
        : `Verification did not pass: ${failed} of ${total} test(s) failed.`,
    );
  }
  // Without --keep-env the environment is deleted when the run ends; a link
  // to it would be dead by the time anyone reads this.
  if (a.keepEnv && a.environment?.url) lines.push(`Test environment: ${a.environment.url}`);
  return lines;
}

export function renderSuccessComment(a: {
  pr: PullRequestDetails;
  rebase: RebaseOutput;
  verification?: VerificationOutput;
  environment?: EnvironmentOutput;
  skippedVerification: boolean;
  /** The environment survives the run (`--keep-env`); only then is it linked. */
  keepEnv: boolean;
}): string {
  const { pr, rebase } = a;
  const source = branch(pr.sourceRefName);
  const lines: string[] = [
    `## Rebased onto ${branch(pr.targetRefName)} @ ${sha7(rebase.targetSha)}`,
    '',
    `\`${sha7(rebase.preRebaseSha)}\` → \`${sha7(rebase.newHeadSha)}\`, ${plural(rebase.commitsReplayed, 'commit')} replayed.`,
    '',
    '### Conflicts',
  ];
  if (rebase.conflicts.length === 0) lines.push('', 'The rebase had no conflicts.');
  else lines.push('', ...conflictLines(rebase.conflicts));
  lines.push('', '### Verification', '', ...verificationLines(a));
  lines.push(
    '',
    '### Local branch',
    '',
    'The remote branch was force-updated. To pick it up locally:',
    '',
    '```',
    `git fetch && git reset --hard origin/${source}`,
    '```',
    '',
    'If you have unpushed commits, use `git pull --rebase` instead.',
  );
  return lines.join('\n');
}

export function renderFailureComment(a: { pr: PullRequestDetails; outcome: PrFixOutcome }): string {
  const { pr, outcome } = a;
  const target = branch(pr.targetRefName);
  const verificationFailed = outcome.status === 'verification-failed';
  const lines: string[] = [
    verificationFailed
      ? `## Rebased onto ${target} locally, but verification failed`
      : `## Could not rebase onto ${target}`,
    '',
    `Status: \`${outcome.status}\``,
  ];
  if (outcome.error) lines.push('', truncate(oneLine(outcome.error), MAX_COMMENT_ERROR_LENGTH));
  const files = [...new Set(outcome.conflicts.flatMap((c) => c.files))];
  if (files.length > 0) lines.push('', 'Conflicted files:', ...files.map((f) => `- \`${f}\``));
  lines.push('', verificationFailed ? 'Nothing was pushed; the branch was not changed.' : 'The branch was not changed.');
  return lines.join('\n');
}
