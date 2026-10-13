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
import { CostExceededError } from '../../../src/types/index.ts';

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
    applyPatch: async (a) => { calls.push(`apply ${a.directory ?? '.'} ${a.patch}`); return true; },
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

  it('a fix that hangs past its own budget is skipped and reset, the next one still applies', async () => {
    const git = fakeGit();
    let i = 0;
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state, c) {
        if (i++ > 0) return state;
        await new Promise((_resolve, reject) => c.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return state;
      },
    };
    const c = { ...ctx(), config: makeTestConfig({}, { stageTimeoutMs: { 'fix-findings': 50 } }) };
    const s = stateFor(twoFixInput());
    await createApplyFixesStage({ git, fixFindings }).execute(s, c);
    expect(git.calls[0]).toBe('reset sha0');
    expect(s.outputs.appliedIds).toEqual(['F002']);
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('a fix the agent declines is reset and skipped, even when it left edits', async () => {
    const git = fakeGit();
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) {
        state.outputs.findingsAddressed = [{ file: 'x.al', action: 'declined', reason: 'does not fit' }];
        return state;
      },
    };
    const s = stateFor();
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(git.calls).toEqual(['reset sha0']);
    expect(s.outputs.appliedIds).toEqual([]);
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('a fix that changes nothing is skipped', async () => {
    const git = fakeGit({ commitFix: async () => null });
    const fixFindings: Stage = { name: 'fix-findings', canRun: () => true, execute: async (st) => st };
    const s = stateFor();
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  function nFixInput(patches: (string | undefined)[], patchDirectory?: string) {
    const input = makeInput(patchDirectory ? { patchDirectory } : {});
    const base = input.suggestions[0]!;
    input.suggestions = patches.map((patch, i) => {
      const id = `F00${i + 1}`;
      return { ...base, id, title: `${id}: t`, description: 'no list', ...(patch !== undefined ? { patch } : {}) };
    });
    return input;
  }

  function countingAgent(costPerFix = 0): Stage & { runs: string[] } {
    const runs: string[] = [];
    return {
      runs,
      name: 'fix-findings', canRun: () => true,
      async execute(state) {
        runs.push((state.outputs.reviewer as ReviewerOutput).findings[0]!.title);
        const prev = (state.outputs.cost as { total: number } | undefined)?.total ?? 0;
        state.outputs.cost = { total: prev + costPerFix, perStage: {} };
        return state;
      },
    };
  }

  it('a fix with a patch is applied and committed without the agent', async () => {
    const git = fakeGit();
    const agent = countingAgent(1);
    const s = stateFor(nFixInput(['P1'], 'src/base-application-test'));
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, ctx());
    expect(agent.runs).toEqual([]);
    expect(git.calls).toEqual(['apply src/base-application-test P1', 'commit test: F001 (mutant-fixer run 1003)']);
    expect(s.outputs.appliedIds).toEqual(['F001']);
    expect(s.outputs.cost).toBeUndefined();
    expect(s.outputs.capReached).toBeUndefined();
  });

  it('a patch that does not apply is reset and the agent applies the fix', async () => {
    const git = fakeGit({ applyPatch: async () => false });
    const agent = countingAgent();
    const s = stateFor(nFixInput(['bad']));
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, ctx());
    expect(agent.runs).toEqual(['F001: t']);
    expect(git.calls).toEqual(['reset sha0', 'commit test: F001 (mutant-fixer run 1003)']);
    expect(s.outputs.appliedIds).toEqual(['F001']);
  });

  it('a patch that applies but changes nothing falls back to the agent', async () => {
    let commits = 0;
    const git = fakeGit({ commitFix: async () => (commits++ === 0 ? null : 'shaX') });
    const agent = countingAgent();
    const s = stateFor(nFixInput(['empty']));
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, ctx());
    expect(agent.runs).toEqual(['F001: t']);
    expect(s.outputs.appliedIds).toEqual(['F001']);
  });

  it('a patch that throws falls back to the agent', async () => {
    const git = fakeGit({ applyPatch: async () => { throw new Error('spawn failed'); } });
    const agent = countingAgent();
    const s = stateFor(nFixInput(['x']));
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, ctx());
    expect(agent.runs).toEqual(['F001: t']);
    expect(s.outputs.appliedIds).toEqual(['F001']);
  });

  it('once the cap is reached it keeps the agent fix, skips later agent fixes and still applies patches', async () => {
    const c = ctx();
    expect(c.config.maxCostUsdPerWi).toBeLessThan(6);
    const git = fakeGit();
    const agent = countingAgent(6);
    const s = stateFor(nFixInput([undefined, undefined, 'P3', undefined]));
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, c);
    expect(agent.runs).toEqual(['F001: t']);
    expect(s.outputs.appliedIds).toEqual(['F001', 'F003']);
    expect(s.outputs.skippedIds).toEqual(['F002', 'F004']);
    expect(s.outputs.capReached).toBe(true);
  });

  it('does not start the agent when the cost is already over the cap', async () => {
    const git = fakeGit({ applyPatch: async () => false });
    const agent = countingAgent();
    const s = stateFor(nFixInput(['bad']));
    s.outputs.cost = { total: 999, perStage: {} };
    await createApplyFixesStage({ git, fixFindings: agent }).execute(s, ctx());
    expect(agent.runs).toEqual([]);
    expect(s.outputs.skippedIds).toEqual(['F001']);
    expect(s.outputs.capReached).toBe(true);
  });

  it('a CostExceededError inside the agent resets and skips that fix, later patches still apply', async () => {
    const git = fakeGit();
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute() { throw new CostExceededError(9, 5, 'fix-findings'); },
    };
    const s = stateFor(nFixInput([undefined, 'P2', undefined]));
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(git.calls[0]).toBe('reset sha0');
    expect(s.outputs.appliedIds).toEqual(['F002']);
    expect(s.outputs.skippedIds).toEqual(['F001', 'F003']);
    expect(s.outputs.capReached).toBe(true);
  });

  it('rethrows when the stage is aborted from outside', async () => {
    const git = fakeGit();
    const outer = new AbortController();
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute() { outer.abort('external'); throw new Error('aborted'); },
    };
    const c = { ...ctx(), signal: outer.signal };
    await expect(createApplyFixesStage({ git, fixFindings }).execute(stateFor(nFixInput([undefined, 'P2'])), c)).rejects.toThrow();
    expect(git.calls.some((x) => x.startsWith('apply'))).toBe(false);
  });
});

describe('push-suggestions', () => {
  it('push-suggestions and create-stacked-pr are cost-free; apply-fixes is not', () => {
    expect(createPushSuggestionsStage({ git: fakeGit() }).costFree).toBe(true);
    expect(createStackedPrStage({ ado: {} as AdoClient }).costFree).toBe(true);
    const fixFindings: Stage = { name: 'fix-findings', canRun: () => true, execute: async (st) => st };
    expect(createApplyFixesStage({ git: fakeGit(), fixFindings }).costFree).toBeUndefined();
  });

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

  it('names the skipped fixes and the cost cap in the description', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    s.outputs.skippedIds = ['F002', 'F003'];
    s.outputs.capReached = true;
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx());
    expect(seen[0]!.description).toContain('2 fixes were not applied (F002, F003). The agent cost cap was reached.');
  });

  it('creates nothing in a dry run', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx(true));
    expect(seen).toHaveLength(0);
  });
});
