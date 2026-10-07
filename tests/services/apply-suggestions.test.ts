import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySuggestions, loadSuggestionConfig } from '../../src/services/apply-suggestions.ts';
import { HeadMovedError, type SuggestionGit } from '../../src/suggestions/suggestion-git.ts';
import { NothingAppliedError } from '../../src/pipeline/stages/suggestions.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { Stage } from '../../src/pipeline/stage.ts';
import { MIN_ENV, makeTestConfig } from '../helpers/app-config.ts';
import { makeInput } from '../helpers/suggestion-input.ts';

const WT = { path: '/wt/x', branch: 'mutant/pr-12345-abc1234', baseSha: 'b' };
const logger = { info() {}, warn() {}, error() {} };

function gitSpy(): SuggestionGit & { removed: unknown[] } {
  const removed: unknown[] = [];
  return { removed, removeWorktree: async (wt: unknown) => { removed.push(wt); } } as unknown as SuggestionGit & { removed: unknown[] };
}

function stage(name: string, fn: (o: Record<string, unknown>) => void): Stage {
  return { name, canRun: () => true, async execute(s) { fn(s.outputs); return s; } };
}

function run(stages: Stage[], opts: { dryRun?: boolean; mode?: 'pr' | 'push' } = {}) {
  const git = gitSpy();
  const config = makeTestConfig({ STATE_DIR: mkdtempSync(join(tmpdir(), 'sugg-')) }, { dryRun: opts.dryRun ?? false });
  return {
    git,
    outcome: applySuggestions({
      config, logger, input: makeInput({ mode: opts.mode ?? 'pr' }), git, stages,
      store: new PipelineStateStore(join(config.stateDir, 'suggestions')),
    }),
  };
}

const happy = [
  stage('suggestion-worktree', (o) => { o.worktree = WT; }),
  stage('apply-fixes', (o) => { o.appliedIds = ['F001']; o.skippedIds = ['F002']; }),
  stage('push-suggestions', (o) => { o.pushedCommit = 'c0ffee'; }),
  stage('create-stacked-pr', (o) => { o.suggestionPr = { id: 12399, url: 'u' }; }),
];

describe('applySuggestions', () => {
  it('pr mode: ok outcome with branch, commit, PR id; worktree removed', async () => {
    const { git, outcome } = run(happy);
    expect(await outcome).toEqual({
      ok: true, branch: 'refs/heads/mutant/pr-12345-abc1234', pushedCommit: 'c0ffee',
      pullRequestId: 12399, appliedIds: ['F001'], skippedIds: ['F002'], error: null,
    });
    expect(git.removed).toEqual([WT]);
  });

  it('push mode: branch is the developer branch and there is no PR id', async () => {
    const { outcome } = run(happy.slice(0, 3), { mode: 'push' });
    const o = await outcome;
    expect(o.branch).toBe('refs/heads/feature/foo');
    expect(o.pullRequestId).toBeNull();
  });

  it('head moved: ok false, error head-moved, nothing to remove', async () => {
    const { git, outcome } = run([
      { name: 'suggestion-worktree', canRun: () => true, execute: async () => { throw new HeadMovedError('feature/foo', 'a', 'b'); } },
    ], { mode: 'push' });
    expect(await outcome).toMatchObject({ ok: false, error: 'head-moved', appliedIds: [], pushedCommit: null });
    expect(git.removed).toEqual([]);
  });

  it('nothing applied: ok false with the skipped ids', async () => {
    const { outcome } = run([
      happy[0]!,
      stage('apply-fixes', (o) => { o.appliedIds = []; o.skippedIds = ['F001']; }),
      { name: 'push-suggestions', canRun: () => true, execute: async () => { throw new NothingAppliedError(); } },
    ]);
    expect(await outcome).toMatchObject({ ok: false, error: 'nothing-applied', skippedIds: ['F001'] });
  });

  it('other failures: ok false naming the stage, PAT redacted', async () => {
    const { git, outcome } = run([
      happy[0]!,
      { name: 'apply-fixes', canRun: () => true, execute: async () => { throw new Error(`boom ${MIN_ENV.AZURE_DEVOPS_PAT}`); } },
    ]);
    const o = await outcome;
    expect(o.ok).toBe(false);
    expect(o.error).toStartWith('apply-fixes: boom');
    expect(o.error).not.toContain(MIN_ENV.AZURE_DEVOPS_PAT);
    expect(git.removed).toEqual([WT]);
  });

  it('dry run keeps the worktree and reports no pushed commit', async () => {
    const { git, outcome } = run(happy, { dryRun: true });
    const o = await outcome;
    expect(o.ok).toBe(true);
    expect(o.pushedCommit).toBeNull();
    expect(o.pullRequestId).toBeNull();
    expect(git.removed).toEqual([]);
  });
});

describe('loadSuggestionConfig', () => {
  const env: Record<string, string> = { ...MIN_ENV, BOT_GIT_NAME: 'Bot', BOT_GIT_EMAIL: 'bot@x' };

  it('needs neither ADO_REPOSITORY_NAME, MAX_COST_USD_PER_WI nor CONTINIA_API_TOKEN', () => {
    const { ADO_REPOSITORY_NAME: _r, MAX_COST_USD_PER_WI: _m, SKIP_BUILD_TEST: _s, ...rest } = env;
    const c = loadSuggestionConfig(rest, makeInput());
    expect(c.repositoryName).toBe('Continia Banking');
    expect(c.skipBuildTest).toBe(true);
    expect(c.maxCostUsdPerWi).toBe(20);
  });

  it('keeps an explicit MAX_COST_USD_PER_WI', () => {
    expect(loadSuggestionConfig({ ...env, MAX_COST_USD_PER_WI: '7' }, makeInput()).maxCostUsdPerWi).toBe(7);
  });

  it('sizes the apply-fixes timeout by the number of fixes', () => {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]!, id: 'F002' });
    const c = loadSuggestionConfig(env, input);
    expect(c.stageTimeoutMs['apply-fixes']).toBe(2 * c.stageTimeoutMs['fix-findings']!);
  });

  it('requires BOT_GIT_NAME and BOT_GIT_EMAIL', () => {
    expect(() => loadSuggestionConfig({ ...env, BOT_GIT_EMAIL: '' }, makeInput())).toThrow(/BOT_GIT_EMAIL/);
  });
});
