/**
 * Bash policy for the write-capable coder agents (the coder stage and the
 * build-and-test fix loop), and the deny half is reused by the read-only plan
 * step. Lives in its own module so `_plan.ts` can import the deny list without
 * a cycle through `coder.ts`.
 */
export const CODER_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^git add (?!-A\b|\.\s*$|--all\b|:\/)/,
  /^git commit\b/,
  /^git rm\b/,
  /^git mv\b/,
  /^(bun |npm |npx )(run )?(typecheck|build|lint)\b/,
  /^bun (run )?typecheck\b/,
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
];

export const CODER_BASH_DENY: RegExp[] = [
  /^git push\b/,
  /^git checkout\b/,
  /^git switch\b/,
  /^git reset\b/,
  /^git rebase\b/,
  /^git merge\b/,
  /^git branch (-d|-D|-m)\b/,
  /^git stash\b/,
  /^git clean\b/,
  /^git config\b/,
  /^git remote\b/,
  /^git commit --amend\b/,
  /^rm\b/,
  /^cd\b/,
  /^bun add\b/,
  /^bun remove\b/,
  /^npm install\b/,
  /^npm i\b/,
  /^pip install\b/,
];
