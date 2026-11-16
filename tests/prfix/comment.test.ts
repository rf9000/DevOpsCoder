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
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false, keepEnv: false });
    expect(c).toContain('Rebased onto main @ bbbbbbb');
    expect(c).toContain('`aaaaaaa` → `ccccccc`');
    expect(c).toContain('3 commits replayed');
  });

  it('lists every conflicted file, with the resolution when present', () => {
    const c = renderSuccessComment({ pr, rebase: conflicted, verification: verified, skippedVerification: false, keepEnv: false });
    expect(c).toContain('d1d1d1d');
    expect(c).toContain('Add retry');
    expect(c).toContain('app/A.al');
    expect(c).toContain('kept both sides');
    expect(c).toContain('app/B.al');
  });

  it('says "no conflicts" when there were none', () => {
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false, keepEnv: false });
    expect(c).toContain('no conflicts');
  });

  it('says "Not verified" when verification was skipped', () => {
    const c = renderSuccessComment({ pr, rebase: clean, skippedVerification: true, keepEnv: false });
    expect(c).toContain('**Not verified** (SKIP_BUILD_TEST)');
  });

  const environment = { envId: 'e1', name: 'wi-1', url: 'https://env.example/x', status: 'Running', createdAt: 'now' };

  it('reports a verification result and the environment URL when the environment is kept', () => {
    const c = renderSuccessComment({
      pr,
      rebase: clean,
      verification: verified,
      environment,
      skippedVerification: false,
      keepEnv: true,
    });
    expect(c).toContain('https://env.example/x');
    expect(c).toMatch(/passed/i);
  });

  it('does not link the environment when it is deleted after the run (no --keep-env)', () => {
    const c = renderSuccessComment({
      pr,
      rebase: clean,
      verification: verified,
      environment,
      skippedVerification: false,
      keepEnv: false,
    });
    expect(c).not.toContain('https://env.example/x');
    expect(c).toMatch(/passed/i);
  });

  it('says "1 commit replayed" for a single commit', () => {
    const c = renderSuccessComment({ pr, rebase: { ...clean, commitsReplayed: 1 }, verification: verified, skippedVerification: false, keepEnv: false });
    expect(c).toContain('1 commit replayed');
    expect(c).not.toContain('1 commits');
  });

  it('collapses multi-line subjects and resolutions to one line', () => {
    const rebase: RebaseOutput = {
      ...clean,
      conflicts: [
        {
          commit: 'd1d1d1d1d1d1',
          subject: 'Add retry\n\n## injected heading',
          files: ['app/A.al'],
          summary: 's',
          resolutions: [{ path: 'app/A.al', resolution: 'kept both\r\n- injected bullet' }],
        },
      ],
    };
    const c = renderSuccessComment({ pr, rebase, verification: verified, skippedVerification: false, keepEnv: false });
    expect(c).toContain('Add retry ## injected heading');
    expect(c).toContain('kept both - injected bullet');
    expect(c).not.toMatch(/^## injected heading/m);
    expect(c).not.toMatch(/^- injected bullet/m);
  });

  it('names the source branch without refs/heads/ in the reset instructions', () => {
    const c = renderSuccessComment({ pr, rebase: clean, verification: verified, skippedVerification: false, keepEnv: false });
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

  it('says the rebase succeeded locally but verification failed, and nothing was pushed', () => {
    const c = renderFailureComment({ pr, outcome: { ...outcome, status: 'verification-failed', error: '2 tests failed' } });
    expect(c).not.toContain('Could not rebase');
    expect(c).toContain('Rebased onto main locally, but verification failed');
    expect(c).toContain('Nothing was pushed');
  });

  it('explains a merge-commit refusal', () => {
    const c = renderFailureComment({
      pr,
      outcome: { ...outcome, status: 'merge-commits', error: 'branch contains 2 merge commits; rebase it manually' },
    });
    expect(c).toContain('merge-commits');
    expect(c).toContain('branch contains 2 merge commits; rebase it manually');
    expect(c).toContain('not changed');
  });

  it('collapses the error to one line and truncates it to 2000 characters', () => {
    const long = `first line\nsecond line\n${'x'.repeat(5000)}`;
    const c = renderFailureComment({ pr, outcome: { ...outcome, error: long } });
    expect(c).toContain('first line second line');
    const errorLine = c.split('\n').find((l) => l.startsWith('first line'))!;
    expect(errorLine.length).toBeLessThanOrEqual(2000);
  });

  it('lists conflicted files', () => {
    const c = renderFailureComment({ pr, outcome: { ...outcome, conflicts: conflicted.conflicts } });
    expect(c).toContain('app/A.al');
    expect(c).toContain('app/B.al');
  });
});
