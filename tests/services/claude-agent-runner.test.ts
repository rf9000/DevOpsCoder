import { describe, it, expect } from 'bun:test';
import { extractJson, buildQueryOptions, STRUCTURED_OUTPUT_INSTRUCTION } from '../../src/services/claude-agent-runner.ts';
import { z } from 'zod';
import type { AgentRunArgs } from '../../src/pipeline/agent-stage.ts';
import type { AppConfig } from '../../src/types/index.ts';
import { createLogger } from '../../src/utils/logger.ts';

describe('extractJson', () => {
  it('returns input as-is when it is already a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the outermost JSON object when surrounded by prose', () => {
    expect(extractJson('Sure! {"verdict":"proceed"} that is the answer.'))
      .toBe('{"verdict":"proceed"}');
  });

  it('returns the trimmed input when no JSON object is found', () => {
    expect(extractJson('  no json here  ')).toBe('no json here');
  });
});

describe('buildQueryOptions', () => {
  const baseConfig = {
    org: 'o',
    orgUrl: 'https://x',
    project: 'p',
    pat: 'pat',
    targetRepoPath: '/r',
    worktreeBase: '/w',
    triggerTag: 'agent implement',
    blockedTag: 'agent-blocked',
    needInputTag: 'need-input',
    pollIntervalMinutes: 5,
    concurrency: 1,
    maxRevisions: 3,
    maxRejectCycles: 3,
    coderMaxTurns: 80,
    testAuthorMaxTurns: 50,
    claudeModel: 'claude-opus-4-7',
    stateDir: '.state',
    assignedToFilter: [],
    dryRun: false,
  } satisfies AppConfig;

  const deps = { config: baseConfig, logger: createLogger() };

  const minimalArgs: AgentRunArgs<unknown> = {
    prompt: 'hi',
    schema: z.unknown(),
  };

  it('uses deps.config.claudeModel when args.model is omitted', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    expect(opts.model).toBe('claude-opus-4-7');
  });

  it('args.model takes precedence over deps.config.claudeModel', () => {
    const opts = buildQueryOptions(
      { ...minimalArgs, model: 'claude-sonnet-4-6' },
      deps,
    );
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('systemPrompt uses claude_code preset with STRUCTURED_OUTPUT_INSTRUCTION when no append is given', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    const sp = opts.systemPrompt as { type: string; preset: string; append: string };
    expect(sp.type).toBe('preset');
    expect(sp.preset).toBe('claude_code');
    expect(sp.append).toBe(STRUCTURED_OUTPUT_INSTRUCTION);
  });

  it('combines STRUCTURED_OUTPUT_INSTRUCTION with caller-provided systemPromptAppend', () => {
    const opts = buildQueryOptions(
      { ...minimalArgs, systemPromptAppend: 'Analyzer-specific rules go here.' },
      deps,
    );
    const sp = opts.systemPrompt as { append: string };
    expect(sp.append).toBe(
      `${STRUCTURED_OUTPUT_INSTRUCTION}\n\nAnalyzer-specific rules go here.`,
    );
  });

  it('omits optional fields when undefined', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();
    expect(opts.cwd).toBeUndefined();
    expect(opts.canUseTool).toBeUndefined();
    expect(opts.settingSources).toBeUndefined();
  });

  it('forwards all optional fields when provided', () => {
    const canUseTool = async () => ({ behavior: 'allow' as const });
    const opts = buildQueryOptions(
      {
        ...minimalArgs,
        tools: ['Read', 'Grep'],
        disallowedTools: ['Edit', 'Write'],
        maxTurns: 20,
        cwd: '/repos/continia-banking',
        canUseTool,
        settingSources: ['project'],
      },
      deps,
    );
    expect(opts.allowedTools).toEqual(['Read', 'Grep']);
    expect(opts.disallowedTools).toEqual(['Edit', 'Write']);
    expect(opts.maxTurns).toBe(20);
    expect(opts.cwd).toBe('/repos/continia-banking');
    expect(opts.canUseTool).toBe(canUseTool);
    expect(opts.settingSources).toEqual(['project']);
  });
});
