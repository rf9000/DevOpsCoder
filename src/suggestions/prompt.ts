import type { BuildFixFindingsPromptArgs } from '../pipeline/stages/fix-findings.ts';

/**
 * User prompt for one verified mutation-test fix. Replaces the fix-findings
 * prompt, whose "the reviewer rejected this" framing and diff section do not
 * apply: the fix was written and verified by al-mutation, and the job is to
 * place it.
 */
export function buildApplySuggestionPrompt(args: BuildFixFindingsPromptArgs): string {
  const f = args.findings[0];
  if (!f) throw new Error('buildApplySuggestionPrompt needs exactly one finding');
  const where =
    f.line !== undefined
      ? `Insert the code after line ${f.line} of \`${f.file}\`.`
      : `The code is a new test procedure: add it to the codeunit in \`${f.file}\`.`;
  return [
    `# Apply one verified mutation-test fix — PR !${args.workItemId}: ${args.workItemTitle}`,
    '',
    `The worktree at \`${args.worktree.path}\` (branch \`${args.worktree.branch}\`) is the PR head. Apply the fix below there and commit.`,
    '',
    `## ${f.title}`,
    '',
    where,
    '',
    f.description,
    '',
    '```al',
    f.suggestion ?? '',
    '```',
    '',
    '## Rules',
    '- The code is already verified on a BC environment: it compiles, passes on this code and kills the named mutants. Apply it as given.',
    '- Change it only to make it fit: a missing local variable, a name clash with an existing procedure, indentation.',
    '- If the line no longer matches (the file changed), find the same place by the procedure name and the surrounding code.',
    '- Edit only this file. Do not change other tests and do not refactor.',
    '- Stage the file (git add <file>), then git commit. Do not push.',
    '- Report the fix in `findingsAddressed` as `fixed`, or `declined` with the reason it cannot be applied.',
  ].join('\n');
}
