import { describe, it, expect } from 'bun:test';
import { createBashAllowlist } from '../../../src/utils/bash-allowlist.ts';
import { CODER_BASH_ALLOW, CODER_BASH_DENY } from '../../../src/pipeline/stages/coder-policy.ts';
import { PLAN_BASH_ALLOW } from '../../../src/pipeline/stages/_plan.ts';
import { PR_MESSAGE_BASH_ALLOW } from '../../../src/pipeline/stages/_pr-message.ts';
import { ANALYZER_BASH_ALLOW, ANALYZER_BASH_DENY } from '../../../src/pipeline/stages/analyzer.ts';
import { REVIEWER_BASH_ALLOW, REVIEWER_BASH_DENY } from '../../../src/pipeline/stages/reviewer.ts';
import { TEST_AUTHOR_BASH_ALLOW, TEST_AUTHOR_BASH_DENY } from '../../../src/pipeline/stages/test-author.ts';
import { RESOLVER_BASH_ALLOW, RESOLVER_BASH_DENY } from '../../../src/prfix/resolver.ts';

/**
 * `git diff/log/show --output=<path>` writes any file, the shared clone's
 * `.git/hooks` included. Every policy that admits those verbs must deny it.
 * Each entry mirrors how the stage builds its createBashAllowlist call.
 */
const POLICIES: [string, RegExp[], RegExp[]][] = [
  ['coder / fix-findings / test-fixer', CODER_BASH_ALLOW, CODER_BASH_DENY],
  ['plan step', PLAN_BASH_ALLOW, CODER_BASH_DENY],
  ['pr-message step', PR_MESSAGE_BASH_ALLOW, CODER_BASH_DENY],
  ['analyzer', ANALYZER_BASH_ALLOW, ANALYZER_BASH_DENY],
  ['reviewer', REVIEWER_BASH_ALLOW, REVIEWER_BASH_DENY],
  ['test-author', TEST_AUTHOR_BASH_ALLOW, TEST_AUTHOR_BASH_DENY],
  ['rebase-resolver', RESOLVER_BASH_ALLOW, RESOLVER_BASH_DENY],
];

describe('git --output is denied by every Bash policy', () => {
  for (const [name, allow, deny] of POLICIES) {
    it(name, async () => {
      const canUse = createBashAllowlist({ allow, deny });
      const decide = async (command: string) =>
        (await canUse('Bash', { command })).behavior;

      expect(await decide('git diff HEAD~1')).toBe('allow');
      for (const cmd of [
        'git diff --output=.git/hooks/pre-commit HEAD~1',
        'git log --output .git/hooks/post-checkout -1',
        'git show --output=x HEAD',
      ]) {
        expect(await decide(cmd)).toBe('deny');
      }
    });
  }
});
