import type { EnvironmentOutput, PullRequestDetails, VerificationOutput } from '../types/index.ts';
import type { CollisionGroup } from './al-objects.ts';
import type { PrFixOutcome, RebaseOutput, RenumberedObject } from './types.ts';

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

/**
 * An alc diagnostic of severity error, from the compiler or an analyzer:
 * `<file>(<line>,<col>): error AL0264: ...`, `... error AA0210: ...` (CodeCop),
 * `AS` (AppSourceCop), `AW` (UICop), `PTE`, `LC` and the like.
 */
export const AL_ERROR_LINE = /: error [A-Z]{2,}\d{4}:/;

/** One AL error line in a comment is capped; alc's messages are short, a pathological one is not. */
const MAX_AL_LINE_LENGTH = 500;

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fenced(lines: string[]): string[] {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, ...lines, fence];
}

function renumberLines(renumbered: RenumberedObject[]): string[] {
  return renumbered.map((r) => `- ${oneLine(r.type)} ${oneLine(r.name)}: ${r.oldId} → ${r.newId} (\`${r.file}\`)`);
}

function collisionLines(groups: CollisionGroup[]): string[] {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`- \`${g.app}\`: ${g.type} ${g.id}`);
    for (const m of g.members) lines.push(`  - \`${m.file}\``);
  }
  return lines;
}

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
  /** The sha that was pushed (the renumber commit included). Defaults to the rebase's head. */
  newHead?: string;
  /** Objects `renumber-collisions` moved to a new ID; a section is rendered when non-empty. */
  renumbered?: RenumberedObject[];
}): string {
  const { pr, rebase } = a;
  const newHead = a.newHead ?? rebase.newHeadSha;
  const source = branch(pr.sourceRefName);
  const lines: string[] = [
    `## Rebased onto ${branch(pr.targetRefName)} @ ${sha7(rebase.targetSha)}`,
    '',
    `\`${sha7(rebase.preRebaseSha)}\` → \`${sha7(newHead)}\`, ${plural(rebase.commitsReplayed, 'commit')} replayed.`,
    '',
    '### Conflicts',
  ];
  if (rebase.conflicts.length === 0) lines.push('', 'The rebase had no conflicts.');
  else lines.push('', ...conflictLines(rebase.conflicts));
  if (a.renumbered && a.renumbered.length > 0) {
    lines.push(
      '',
      '### Renumbered object IDs',
      '',
      'These PR objects collided with an object on the target and were moved to a new ID, in a separate commit:',
      '',
      ...renumberLines(a.renumbered),
    );
  }
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

export function renderFailureComment(a: {
  pr: PullRequestDetails;
  outcome: PrFixOutcome;
  /** The groups an `id-collision` refusal named. */
  collisions?: CollisionGroup[];
}): string {
  const { pr, outcome } = a;
  const target = branch(pr.targetRefName);
  const verificationFailed = outcome.status === 'verification-failed';
  const idCollision = outcome.status === 'id-collision';
  const lines: string[] = [
    verificationFailed
      ? `## Rebased onto ${target} locally, but verification failed`
      : idCollision
        ? '## Object ID collision needs a manual fix'
        : `## Could not rebase onto ${target}`,
    '',
    `Status: \`${outcome.status}\``,
  ];
  // fixPr appends a verification failure's AL error lines to its error, one per
  // line; they go in a block of their own and the rest stays the message.
  const errorLines = (outcome.error ?? '').split(/\r?\n/);
  const isAlLine = (l: string, i: number) => verificationFailed && i > 0 && AL_ERROR_LINE.test(l);
  const alLines = errorLines.filter(isAlLine);
  const message = errorLines.filter((l, i) => !isAlLine(l, i)).join('\n');
  if (message.trim()) lines.push('', truncate(oneLine(message), MAX_COMMENT_ERROR_LENGTH));
  if (alLines.length > 0) {
    lines.push('', ...fenced(alLines.map((l) => truncate(l, MAX_AL_LINE_LENGTH))));
  }
  if (idCollision && a.collisions && a.collisions.length > 0) {
    lines.push('', 'Colliding objects:', ...collisionLines(a.collisions));
  }
  const files = [...new Set(outcome.conflicts.flatMap((c) => c.files))];
  if (files.length > 0) lines.push('', 'Conflicted files:', ...files.map((f) => `- \`${f}\``));
  lines.push('', verificationFailed ? 'Nothing was pushed; the branch was not changed.' : 'The branch was not changed.');
  return lines.join('\n');
}
