import { describe, it, expect } from 'bun:test';
import { renderFailureComment, renderSuccessComment } from '../../src/prfix/comment.ts';
import type { PrFixOutcome, RebaseOutput } from '../../src/prfix/types.ts';
import type { PullRequestDetails, VerificationOutput } from '../../src/types/index.ts';

const pr: PullRequestDetails = {
  id: 42,
  status: 'active',
  title: 'My PR',
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  headCommit: 'aaaaaaa1111111',
  isDraft: false,
  url: 'https://example/pr/42',
};

const clean: RebaseOutput = {
  preRebaseSha: 'aaaaaaa1111111',
  targetSha: 'bbbbbbb2222222',
  newHeadSha: 'ccccccc3333333',
  commitsReplayed: 3,
  conflicts: [],
};

const conflicted: RebaseOutput = {
  ...clean,
  conflicts: [
    {
      commit: 'd1d1d1d1d1d1',
      subject: 'Add retry',
      files: ['app/A.al', 'app/B.al'],
      summary: 's',
      resolutions: [{ path: 'app/A.al', resolution: 'kept both sides' }],
    },
  ],
};

const verified: VerificationOutput = { attempts: 0, compiled: true, deploy: [], testRuns: [], passed: true };

describe('renderSuccessComment', () => {
  it('has the headline with short target sha and old to new shas', () => {
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false });
    expect(c).toContain('Rebased onto main @ bbbbbbb');
    expect(c).toContain('`aaaaaaa` → `ccccccc`');
    expect(c).toContain('3 commits replayed');
  });

  it('lists every conflicted file, with the resolution when present', () => {
    const c = renderSuccessComment({ pr, rebase: conflicted, verification: verified, skippedVerification: false });
    expect(c).toContain('d1d1d1d');
    expect(c).toContain('Add retry');
    expect(c).toContain('app/A.al');
    expect(c).toContain('kept both sides');
    expect(c).toContain('app/B.al');
  });

  it('says "no conflicts" when there were none', () => {
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false });
    expect(c).toContain('no conflicts');
  });

  it('says "Not verified" when verification was skipped', () => {
    const c = renderSuccessComment({ pr, rebase: clean, skippedVerification: true });
    expect(c).toContain('**Not verified** (SKIP_BUILD_TEST)');
  });

  it('reports a verification result and the environment URL', () => {
    const c = renderSuccessComment({
      pr,
      rebase: clean,
      verification: verified,
      environment: { envId: 'e1', name: 'wi-1', url: 'https://env.example/x', status: 'Running', createdAt: 'now' },
      skippedVerification: false,
    });
    expect(c).toContain('https://env.example/x');
    expect(c).toMatch(/passed/i);
  });

  it('names the source branch without refs/heads/ in the reset instructions', () => {
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false });
    expect(c).toContain('git fetch && git reset --hard origin/feature/x');
    expect(c).toContain('git pull --rebase');
    expect(c).not.toContain('refs/heads/');
  });
});

describe('renderFailureComment', () => {
  const outcome: PrFixOutcome = {
    ok: false,
    status: 'unresolved-conflict',
    pullRequestId: 42,
    oldHead: 'aaaaaaa1111111',
    newHead: null,
    conflicts: [],
    costUsd: 1,
    error: 'unresolved conflict in commit abc: app/A.al',
  };

  it('says the branch was not changed and carries the status and error', () => {
    const c = renderFailureComment({ pr, outcome });
    expect(c).toContain('not changed');
    expect(c).toContain('unresolved-conflict');
    expect(c).toContain('unresolved conflict in commit abc: app/A.al');
  });

  it('lists conflicted files', () => {
    const c = renderFailureComment({ pr, outcome: { ...outcome, conflicts: conflicted.conflicts } });
    expect(c).toContain('app/A.al');
    expect(c).toContain('app/B.al');
  });
});
