import { describe, it, expect, mock } from 'bun:test';
import {
  RESOLVER_BASH_ALLOW,
  buildResolverPrompt,
  resolveConflict,
  resolverOutputSchema,
} from '../../src/prfix/resolver.ts';
import type { AgentRunArgs, AgentRunner } from '../../src/pipeline/agent-stage.ts';
import type { PipelineState } from '../../src/types/index.ts';
import { AgentOutputParseError } from '../../src/services/claude-agent-runner.ts';
import { MAX_TRANSIENT_RETRIES } from '../../src/pipeline/stages/_stage-helpers.ts';
import { createBashAllowlist } from '../../src/utils/bash-allowlist.ts';
import { makeTestConfig } from '../helpers/app-config.ts';
import { TEST_USAGE } from '../helpers/agent-usage.ts';

const step = {
  kind: 'conflict' as const,
  commit: 'c0ffee1234567890',
  subject: 'Add payment export retry',
  files: ['app/A.al', 'app/B.al'],
};

function makeState(): PipelineState {
  return {
    workItemId: 0,
    slug: 'pr-42',
    startedAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    currentStage: null,
    history: [],
    outputs: {},
  };
}

function okRunner(captured: AgentRunArgs<unknown>[]): AgentRunner {
  return {
    run: mock(async (args: AgentRunArgs<unknown>) => {
      captured.push(args);
      return {
        value: { files: [{ path: 'app/A.al', resolution: 'kept both' }], summary: 'resolved' },
        costUsd: 0.25,
        toolUsage: { Edit: 2 },
        usage: TEST_USAGE,
      };
    }),
  } as unknown as AgentRunner;
}

function callResolve(runner: AgentRunner, state: PipelineState, config = makeTestConfig()) {
  return resolveConflict({
    runner,
    config,
    promptTemplate: 'SYSTEM',
    maxTurns: 17,
    worktreePath: '/w/prfix-42',
    step,
    targetSha: 'beefbeef',
    prTitle: 'My PR',
    state,
    signal: new AbortController().signal,
  });
}

describe('buildResolverPrompt', () => {
  it('names the commit, subject, every file and targetSha', () => {
    const p = buildResolverPrompt({
      commit: step.commit,
      subject: step.subject,
      files: step.files,
      targetSha: 'beefbeef',
      prTitle: 'My PR',
    });
    expect(p).toContain(step.commit);
    expect(p).toContain(step.subject);
    expect(p).toContain('app/A.al');
    expect(p).toContain('app/B.al');
    expect(p).toContain('beefbeef');
    expect(p).toContain('My PR');
  });
});

describe('resolverOutputSchema', () => {
  it('accepts files with path and resolution plus a summary', () => {
    const v = resolverOutputSchema.parse({ files: [{ path: 'a', resolution: 'r' }], summary: 's' });
    expect(v.files[0]?.path).toBe('a');
  });
});

describe('RESOLVER_BASH_ALLOW', () => {
  const filter = createBashAllowlist({ allow: RESOLVER_BASH_ALLOW, deny: [] });
  const verdict = async (command: string) => (await filter('Bash', { command })).behavior;

  it('rejects git add, git rebase, git checkout', async () => {
    expect(await verdict('git add app/A.al')).toBe('deny');
    expect(await verdict('git rebase --continue')).toBe('deny');
    expect(await verdict('git checkout --theirs app/A.al')).toBe('deny');
  });

  it('allows read-only inspection', async () => {
    expect(await verdict('git show c0ffee1')).toBe('allow');
    expect(await verdict('git log beefbeef -- app/A.al')).toBe('allow');
    expect(await verdict('git diff')).toBe('allow');
    expect(await verdict('git status')).toBe('allow');
    expect(await verdict('git blame app/A.al')).toBe('allow');
    expect(await verdict('ls app')).toBe('allow');
    expect(await verdict('cat app/A.al')).toBe('allow');
    expect(await verdict('pwd')).toBe('allow');
  });
});

describe('resolveConflict', () => {
  it('passes tools Read/Grep/Glob/Bash/Edit/Write, disallows ReportFindings, uses modelFor(config,\'rebase-resolver\'), bills cost key \'rebase-resolver\'', async () => {
    const captured: AgentRunArgs<unknown>[] = [];
    const state = makeState();
    const config = makeTestConfig({}, { claudeModel: 'fallback', stepModel: { 'rebase-resolver': 'resolver-model' } });
    const out = await callResolve(okRunner(captured), state, config);
    expect(out).toEqual({ files: [{ path: 'app/A.al', resolution: 'kept both' }], summary: 'resolved' });

    expect(captured).toHaveLength(1);
    const args = captured[0]!;
    expect(args.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
    expect(args.disallowedTools).toContain('ReportFindings');
    expect(args.model).toBe('resolver-model');
    expect(args.cwd).toBe('/w/prfix-42');
    expect(args.maxTurns).toBe(17);
    expect(args.systemPromptAppend).toBe('SYSTEM');
    expect(args.settingSources).toEqual(['project']);
    expect(args.canUseTool).toBeDefined();
    expect(args.prompt).toContain(step.commit);
    const cost = state.outputs.cost as { perStage: Record<string, { usd: number }> };
    expect(cost.perStage['rebase-resolver']?.usd).toBeCloseTo(0.25);
    expect((state.outputs.toolUsage as Record<string, number>).Edit).toBe(2);
  });

  it('denies a state-changing git command and a path outside the worktree', async () => {
    const captured: AgentRunArgs<unknown>[] = [];
    await callResolve(okRunner(captured), makeState());
    const canUseTool = captured[0]!.canUseTool!;
    expect((await canUseTool('Bash', { command: 'git rebase --continue' })).behavior).toBe('deny');
    expect((await canUseTool('Edit', { file_path: '/etc/passwd' })).behavior).toBe('deny');
  });

  it('retries an AgentOutputParseError up to MAX_TRANSIENT_RETRIES', async () => {
    let calls = 0;
    const runner = {
      run: mock(async () => {
        calls++;
        throw new AgentOutputParseError('prose', 'did not parse', {
          costUsd: 0.1, toolUsage: {}, usage: TEST_USAGE,
        });
      }),
    } as unknown as AgentRunner;
    const state = makeState();
    await expect(callResolve(runner, state)).rejects.toBeInstanceOf(AgentOutputParseError);
    expect(calls).toBe(MAX_TRANSIENT_RETRIES + 1);
    // Failed attempts are still billed.
    const cost = state.outputs.cost as { perStage: Record<string, { usd: number }> };
    expect(cost.perStage['rebase-resolver']?.usd).toBeCloseTo(0.1 * (MAX_TRANSIENT_RETRIES + 1));
  });

  it('succeeds on a retry after a parse error', async () => {
    let calls = 0;
    const runner = {
      run: mock(async () => {
        calls++;
        if (calls === 1) throw new AgentOutputParseError('prose', 'did not parse');
        return { value: { files: [], summary: 'ok' }, costUsd: 0, toolUsage: {}, usage: TEST_USAGE };
      }),
    } as unknown as AgentRunner;
    await callResolve(runner, makeState());
    expect(calls).toBe(2);
  });

  it('does not retry a non-parse error', async () => {
    let calls = 0;
    const runner = {
      run: mock(async () => {
        calls++;
        throw new Error('boom');
      }),
    } as unknown as AgentRunner;
    await expect(callResolve(runner, makeState())).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
