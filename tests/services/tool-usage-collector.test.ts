import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import {
  createToolUsageCollector,
  withToolUsageHooks,
  appendToolUsage,
  TOOL_USAGE_FILE,
} from '../../src/services/tool-usage-collector.ts';

const META = { runId: 'run-1', workItemId: 42, at: '2026-11-10T10:00:00.000Z' };

function msg(m: unknown): SDKMessage {
  return m as SDKMessage;
}

function assistant(blocks: unknown[], parent: string | null = null): SDKMessage {
  return msg({ type: 'assistant', message: { content: blocks }, parent_tool_use_id: parent });
}

function init(over: Record<string, unknown> = {}): SDKMessage {
  return msg({
    type: 'system',
    subtype: 'init',
    cwd: '/work/wt',
    tools: [],
    mcp_servers: [],
    skills: [],
    plugins: [],
    agents: [],
    slash_commands: [],
    ...over,
  });
}

async function fireInstructions(hooks: ReturnType<ReturnType<typeof createToolUsageCollector>['hooks']>, input: unknown) {
  const cb = hooks.InstructionsLoaded![0]!.hooks[0]!;
  return cb(input as never, undefined, { signal: new AbortController().signal });
}

describe('createToolUsageCollector', () => {
  test('counts tools, skills and subagents', () => {
    const c = createToolUsageCollector();
    c.observe(
      assistant([
        { type: 'tool_use', id: 'a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'b', name: 'Read', input: {} },
        { type: 'tool_use', id: 'c', name: 'Skill', input: { skill: 'bc-debug' } },
        { type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore' } },
      ]),
    );
    c.observe(assistant([{ type: 'tool_use', id: 'd', name: 'Grep', input: {} }], 't1'));
    const r = c.record(META);
    expect(r.tools).toEqual({ Read: 2, Skill: 1, Agent: 1, Grep: 1 });
    expect(r.skills).toEqual({ 'bc-debug': 1 });
    expect(r.subagents).toEqual({ Explore: 1 });
    expect(r.bySubagent).toEqual({ Explore: { Grep: 1 } });
    expect(r.v).toBe(1);
    expect(r.runId).toBe('run-1');
    expect(r.workItemId).toBe(42);
    expect(r.at).toBe(META.at);
    expect(r.partial).toBeUndefined();
  });

  test('Task tool defaults to general-purpose', () => {
    const c = createToolUsageCollector();
    c.observe(assistant([{ type: 'tool_use', id: 't', name: 'Task', input: {} }]));
    expect(c.record(META).subagents).toEqual({ 'general-purpose': 1 });
  });

  test('merges sessions', () => {
    const c = createToolUsageCollector();
    c.observe(init({ skills: ['b', 'a'], mcp_servers: [{ name: 'ado', status: 'failed' }] }));
    c.observe(
      init({
        skills: ['c', 'a'],
        agents: ['Explore'],
        slash_commands: ['/x'],
        plugins: [{ name: 'p1', path: '/p' }],
        mcp_servers: [{ name: 'ado', status: 'connected' }],
      }),
    );
    const r = c.record(META);
    expect(r.sessions).toBe(2);
    expect(r.available.skills).toEqual(['a', 'b', 'c']);
    expect(r.available.mcpServers).toEqual([{ name: 'ado', status: 'connected' }]);
    expect(r.available.agents).toEqual(['Explore']);
    expect(r.available.plugins).toEqual(['p1']);
    expect(r.available.commands).toEqual(['/x']);
  });

  test('tolerates init without optional fields', () => {
    const c = createToolUsageCollector();
    c.observe(msg({ type: 'system', subtype: 'init', cwd: '/w' }));
    const r = c.record(META);
    expect(r.sessions).toBe(1);
    expect(r.available.skills).toEqual([]);
  });

  test('instructions relative and de-duplicated', async () => {
    const c = createToolUsageCollector();
    c.observe(init());
    const input = {
      hook_event_name: 'InstructionsLoaded',
      file_path: '/work/wt/.claude/rules/a.md',
      load_reason: 'path_glob_match',
      trigger_file_path: '/work/wt/src/x.al',
    };
    expect(await fireInstructions(c.hooks(), input)).toEqual({});
    await fireInstructions(c.hooks(), input);
    expect(c.record(META).instructions).toEqual([
      { path: '.claude/rules/a.md', reason: 'path_glob_match', trigger: 'src/x.al' },
    ]);
  });

  test('instructions relative to the hook cwd before any init', async () => {
    const c = createToolUsageCollector();
    await fireInstructions(c.hooks(), {
      hook_event_name: 'InstructionsLoaded',
      cwd: '/work/wt',
      file_path: '/work/wt/.claude/rules/a.md',
      load_reason: 'path_glob_match',
      trigger_file_path: '/work/wt/src/x.al',
    });
    expect(c.record(META).instructions).toEqual([
      { path: '.claude/rules/a.md', reason: 'path_glob_match', trigger: 'src/x.al' },
    ]);
  });

  test('instructions null when no event', () => {
    expect(createToolUsageCollector().record(META).instructions).toBeNull();
  });

  test('partial only when requested', () => {
    expect(createToolUsageCollector().record({ ...META, partial: true }).partial).toBe(true);
    expect(createToolUsageCollector().record({ ...META, partial: false }).partial).toBeUndefined();
  });

  test('never stores inputs', () => {
    const c = createToolUsageCollector();
    c.observe(
      assistant([
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'curl -H "Authorization: PAT-SECRET-123"' } },
        { type: 'tool_use', id: 'b', name: 'mcp__ado__create', input: { text: 'customer data' } },
      ]),
    );
    const json = JSON.stringify(c.record(META));
    expect(json).not.toContain('PAT-SECRET-123');
    expect(json).not.toContain('customer data');
    expect(json).toContain('mcp__ado__create');
  });
});

describe('withToolUsageHooks', () => {
  test('keeps existing hooks', () => {
    const m: HookCallbackMatcher = { hooks: [async () => ({})] };
    const out = withToolUsageHooks({ PreToolUse: [m] }, createToolUsageCollector());
    expect(Object.keys(out!).sort()).toEqual(['InstructionsLoaded', 'PreToolUse']);
    expect(out!.PreToolUse).toEqual([m]);
  });

  test('concatenates same event and passes through without collector', () => {
    const a: HookCallbackMatcher = { hooks: [async () => ({})] };
    const out = withToolUsageHooks({ InstructionsLoaded: [a] }, createToolUsageCollector());
    expect(out!.InstructionsLoaded!.length).toBe(2);
    expect(out!.InstructionsLoaded![0]).toBe(a);
    const base = { PreToolUse: [a] };
    expect(withToolUsageHooks(base, undefined)).toBe(base);
    expect(withToolUsageHooks(undefined, undefined)).toBeUndefined();
  });
});

describe('appendToolUsage', () => {
  test('writes next to the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-usage-'));
    const rec = createToolUsageCollector().record(META);
    appendToolUsage(join(dir, 'cost-ledger.jsonl'), rec);
    appendToolUsage(join(dir, 'cost-ledger.jsonl'), rec);
    const lines = readFileSync(join(dir, TOOL_USAGE_FILE), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).runId).toBe('run-1');
    expect(existsSync(join(dir, 'cost-ledger.jsonl'))).toBe(false);
  });

  test('warns once and does not throw when unwritable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-usage-'));
    const bad = join(dir, 'missing', 'sub', 'cost-ledger.jsonl');
    const rec = createToolUsageCollector().record(META);
    const warnings: string[] = [];
    appendToolUsage(bad, rec, (m) => warnings.push(m));
    appendToolUsage(bad, rec, (m) => warnings.push(m));
    expect(warnings.length).toBe(1);
  });
});
