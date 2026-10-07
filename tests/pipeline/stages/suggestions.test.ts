import { describe, it, expect } from 'bun:test';
import {
  createApplyFixesStage,
  createPushSuggestionsStage,
  createStackedPrStage,
  createSuggestionWorktreeStage,
  NothingAppliedError,
} from '../../../src/pipeline/stages/suggestions.ts';
import type { SuggestionGit } from '../../../src/suggestions/suggestion-git.ts';
import type { Stage, PipelineContext } from '../../../src/pipeline/stage.ts';
import { createInitialState } from '../../../src/pipeline/orchestrator.ts';
import type { AdoClient } from '../../../src/sdk/azure-devops-client.ts';
import type { CreatePullRequestArgs, PipelineState, ReviewerOutput } from '../../../src/types/index.ts';
import { makeTestConfig } from '../../helpers/app-config.ts';
import { makeInput } from '../../helpers/suggestion-input.ts';

const WT = { path: '/wt/x', branch: 'mutant/pr-12345-abc1234', baseSha: 'abc1234def5678abc1234def5678abc1234def56' };

function fakeGit(over: Partial<SuggestionGit> = {}): SuggestionGit & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    createPrWorktree: async () => { calls.push('pr-worktree'); return WT; },
    createPushWorktree: async () => { calls.push('push-worktree'); return WT; },
    headSha: async () => `sha${n}`,
    resetHard: async (_p, sha) => { calls.push(`reset ${sha}`); },
    commitFix: async ({ message }) => { calls.push(`commit ${message}`); n++; return `sha${n}`; },
    push: async (a) => { calls.push(`push ${a.mode} ${a.remoteBranch}`); },
    removeWorktree: async () => { calls.push('remove'); },
    ...over,
  };
}

function ctx(dryRun = false): PipelineContext {
  return {
    config: makeTestConfig({}, { dryRun }),
    logger: { info() {}, warn() {}, error() {} },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-10-07T00:00:00Z'),
  };
}

function stateFor(input = makeInput()): PipelineState {
  const s = createInitialState(input.pullRequestId, 'pr-abc1234');
  s.outputs.suggestionInput = input;
  s.outputs.worktree = WT;
  return s;
}

describe('suggestion-worktree', () => {
  it('uses the pr worktree in pr mode and sets a minimal wiContext', async () => {
    const git = fakeGit();
    const s = createInitialState(12345, 'x');
    s.outputs.suggestionInput = makeInput();
    await createSuggestionWorktreeStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['pr-worktree']);
    expect(s.outputs.worktree).toEqual(WT);
    expect((s.outputs.wiContext as { id: number; title: string })).toMatchObject({ id: 12345, title: 'Mutation fixes for !12345 (run 1003)' });
  });

  it('uses the push worktree in push mode', async () => {
    const git = fakeGit();
    const s = createInitialState(12345, 'x');
    s.outputs.suggestionInput = makeInput({ mode: 'push' });
    await createSuggestionWorktreeStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push-worktree']);
  });
});

describe('apply-fixes', () => {
  function twoFixInput() {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]!, id: 'F002', title: 'F002: t', description: 'Kills mutants: 9' });
    return input;
  }

  it('runs fix-findings once per fix, each with only its own finding, and commits each', async () => {
    const git = fakeGit();
    const seen: string[][] = [];
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) {
        seen.push((state.outputs.reviewer as ReviewerOutput).findings.map((f) => f.title));
        return state;
      },
    };
    const s = stateFor(twoFixInput());
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(seen).toEqual([['F001: add-assert in SomeTest'], ['F002: t']]);
    expect(git.calls).toEqual([
      'commit test: F001 kill mutants 140, 141 (mutant-fixer run 1003)',
      'commit test: F002 kill mutants 9 (mutant-fixer run 1003)',
    ]);
    expect(s.outputs.appliedIds).toEqual(['F001', 'F002']);
    expect(s.outputs.skippedIds).toEqual([]);
    expect(s.outputs.reviewer).toBeUndefined();
  });

  it('a failing fix is skipped and reset, the next one still applies', async () => {
    const git = fakeGit();
    let i = 0;
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) { if (i++ === 0) throw new Error('agent blew up'); return state; },
    };
    const s = stateFor(twoFixInput());
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(git.calls[0]).toBe('reset sha0');
    expect(s.outputs.appliedIds).toEqual(['F002']);
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('a fix that changes nothing is skipped', async () => {
    const git = fakeGit({ commitFix: async () => null });
    const fixFindings: Stage = { name: 'fix-findings', canRun: () => true, execute: async (st) => st };
    const s = stateFor();
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('stops when the cost cap is exceeded', async () => {
    const git = fakeGit();
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) { state.outputs.cost = { total: 999 } as unknown; return state; },
    };
    await expect(createApplyFixesStage({ git, fixFindings }).execute(stateFor(twoFixInput()), ctx())).rejects.toThrow();
  });
});

describe('push-suggestions', () => {
  it('pr mode pushes the mutant branch and records HEAD', async () => {
    const git = fakeGit();
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push pr mutant/pr-12345-abc1234']);
    expect(s.outputs.pushedCommit).toBe('sha0');
  });

  it('push mode pushes to the developer branch', async () => {
    const git = fakeGit();
    const s = stateFor(makeInput({ mode: 'push' }));
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push push feature/foo']);
  });

  it('does not push in a dry run', async () => {
    const git = fakeGit();
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx(true));
    expect(git.calls).toEqual([]);
  });

  it('throws NothingAppliedError when no fix applied', async () => {
    const s = stateFor();
    s.outputs.appliedIds = [];
    await expect(createPushSuggestionsStage({ git: fakeGit() }).execute(s, ctx())).rejects.toBeInstanceOf(NothingAppliedError);
  });
});

describe('create-stacked-pr', () => {
  function fakeAdo(seen: CreatePullRequestArgs[]): AdoClient {
    return {
      createPullRequest: async (a: CreatePullRequestArgs) => { seen.push(a); return { id: 12399, url: 'u', sourceRefName: a.sourceRefName, targetRefName: a.targetRefName }; },
    } as unknown as AdoClient;
  }

  it('opens a non-draft PR into the developer branch with the creator as reviewer', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      repositoryName: 'Continia Banking',
      sourceRefName: 'refs/heads/mutant/pr-12345-abc1234',
      targetRefName: 'refs/heads/feature/foo',
      title: 'Mutation fixes for !12345 (run 1003)',
      isDraft: false,
      reviewers: [{ id: 'guid-creator' }],
    });
    expect(seen[0]!.workItemId).toBeUndefined();
    expect(s.outputs.suggestionPr).toEqual({ id: 12399, url: 'u' });
  });

  it('creates nothing in a dry run', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx(true));
    expect(seen).toHaveLength(0);
  });
});
