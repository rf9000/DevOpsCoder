import type { EnvironmentOutput, PullRequestDetails, VerificationOutput } from '../types/index.ts';
import type { PrFixOutcome, RebaseOutput } from './types.ts';

const sha7 = (sha: string): string => sha.slice(0, 7);
const branch = (ref: string): string => ref.replace(/^refs\/heads\//, '');

function conflictLines(conflicts: RebaseOutput['conflicts']): string[] {
  const lines: string[] = [];
  for (const c of conflicts) {
    lines.push(`- \`${sha7(c.commit)}\` ${c.subject}`);
    for (const path of c.files) {
      const resolution = c.resolutions.find((r) => r.path === path)?.resolution;
      lines.push(resolution ? `  - \`${path}\`: ${resolution}` : `  - \`${path}\``);
    }
  }
  return lines;
}

function verificationLines(a: {
  verification?: VerificationOutput;
  environment?: EnvironmentOutput;
  skippedVerification: boolean;
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
  if (a.environment?.url) lines.push(`Test environment: ${a.environment.url}`);
  return lines;
}

export function renderSuccessComment(a: {
  pr: PullRequestDetails;
  rebase: RebaseOutput;
  verification?: VerificationOutput;
  environment?: EnvironmentOutput;
  skippedVerification: boolean;
}): string {
  const { pr, rebase } = a;
  const source = branch(pr.sourceRefName);
  const lines: string[] = [
    `## Rebased onto ${branch(pr.targetRefName)} @ ${sha7(rebase.targetSha)}`,
    '',
    `\`${sha7(rebase.preRebaseSha)}\` → \`${sha7(rebase.newHeadSha)}\`, ${rebase.commitsReplayed} commits replayed.`,
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
  const lines: string[] = [
    `## Could not rebase onto ${branch(pr.targetRefName)}`,
    '',
    `Status: \`${outcome.status}\``,
  ];
  if (outcome.error) lines.push('', outcome.error);
  const files = [...new Set(outcome.conflicts.flatMap((c) => c.files))];
  if (files.length > 0) lines.push('', 'Conflicted files:', ...files.map((f) => `- \`${f}\``));
  lines.push('', 'The branch was not changed.');
  return lines.join('\n');
}
