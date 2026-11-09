import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HookCallbackMatcher, HookEvent, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export const TOOL_USAGE_FILE = 'tool-usage.jsonl';

/** One line of tool-usage.jsonl: names and counts of what one agent job used. Never inputs or results. */
export interface ToolUsageRecord {
  v: 1;
  runId: string;
  workItemId: number;
  at: string;
  partial?: true;
  sessions: number;
  tools: Record<string, number>;
  skills: Record<string, number>;
  subagents: Record<string, number>;
  bySubagent: Record<string, Record<string, number>>;
  available: {
    skills: string[];
    mcpServers: { name: string; status: string }[];
    agents: string[];
    plugins: string[];
    commands: string[];
  };
  instructions: { path: string; reason: string; trigger?: string }[] | null;
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export interface ToolUsageCollector {
  /** Feed every SDK message of the job through here. */
  observe(message: SDKMessage): void;
  /** Hooks to merge into the query options (see withToolUsageHooks). */
  hooks(): Hooks;
  record(meta: { runId: string; workItemId: number; at: string; partial?: boolean }): ToolUsageRecord;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function createToolUsageCollector(): ToolUsageCollector {
  let sessions = 0;
  const tools: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const subagents: Record<string, number> = {};
  const bySubagent: Record<string, Record<string, number>> = {};
  const subagentByToolUseId = new Map<string, string>();

  const availSkills = new Set<string>();
  const availAgents = new Set<string>();
  const availPlugins = new Set<string>();
  const availCommands = new Set<string>();
  const mcp = new Map<string, string>();
  let cwd: string | undefined;

  const instructions: { path: string; reason: string; trigger?: string }[] = [];
  const seenPaths = new Set<string>();

  const relative = (p: string): string => {
    const norm = p.replaceAll('\\', '/');
    if (!cwd) return norm;
    const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
    return norm.startsWith(base + '/') ? norm.slice(base.length + 1) : norm;
  };

  function observeInit(m: Record<string, unknown>): void {
    sessions += 1;
    if (typeof m.cwd === 'string') cwd = m.cwd;
    for (const s of strings(m.skills)) availSkills.add(s);
    for (const s of strings(m.agents)) availAgents.add(s);
    for (const s of strings(m.slash_commands)) availCommands.add(s);
    if (Array.isArray(m.plugins)) {
      for (const p of m.plugins) {
        const name = (p as { name?: unknown } | null)?.name;
        if (typeof name === 'string') availPlugins.add(name);
      }
    }
    if (Array.isArray(m.mcp_servers)) {
      for (const s of m.mcp_servers) {
        const { name, status } = (s ?? {}) as { name?: unknown; status?: unknown };
        if (typeof name === 'string') mcp.set(name, typeof status === 'string' ? status : 'unknown');
      }
    }
  }

  function observeAssistant(m: Record<string, unknown>): void {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined;
    const parentType = parent ? subagentByToolUseId.get(parent) : undefined;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const name: string = block.name;
      const input = (block.input ?? {}) as Record<string, unknown>;
      bump(tools, name);
      if (name === 'Skill' && typeof input.skill === 'string') bump(skills, input.skill);
      if (name === 'Agent' || name === 'Task') {
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose';
        bump(subagents, type);
        if (typeof block.id === 'string') subagentByToolUseId.set(block.id, type);
      }
      if (parentType) bump((bySubagent[parentType] ??= {}), name);
    }
  }

  return {
    observe(message) {
      const m = message as unknown as Record<string, unknown>;
      if (m.type === 'system' && m.subtype === 'init') observeInit(m);
      else if (m.type === 'assistant') observeAssistant(m);
    },

    hooks() {
      return {
        InstructionsLoaded: [
          {
            hooks: [
              async (input) => {
                const i = input as { file_path?: unknown; load_reason?: unknown; trigger_file_path?: unknown };
                if (typeof i.file_path !== 'string') return {};
                const path = relative(i.file_path);
                if (seenPaths.has(path)) return {};
                seenPaths.add(path);
                const entry: { path: string; reason: string; trigger?: string } = {
                  path,
                  reason: typeof i.load_reason === 'string' ? i.load_reason : 'unknown',
                };
                if (typeof i.trigger_file_path === 'string') entry.trigger = relative(i.trigger_file_path);
                instructions.push(entry);
                return {};
              },
            ],
          },
        ],
      };
    },

    record(meta) {
      const sorted = (set: Set<string>) => [...set].sort();
      const rec: ToolUsageRecord = {
        v: 1,
        runId: meta.runId,
        workItemId: meta.workItemId,
        at: meta.at,
        sessions,
        tools: { ...tools },
        skills: { ...skills },
        subagents: { ...subagents },
        bySubagent: Object.fromEntries(Object.entries(bySubagent).map(([k, v]) => [k, { ...v }])),
        available: {
          skills: sorted(availSkills),
          mcpServers: [...mcp].map(([name, status]) => ({ name, status })).sort((a, b) => a.name.localeCompare(b.name)),
          agents: sorted(availAgents),
          plugins: sorted(availPlugins),
          commands: sorted(availCommands),
        },
        instructions: seenPaths.size === 0 ? null : instructions.map((e) => ({ ...e })),
      };
      if (meta.partial) rec.partial = true;
      return rec;
    },
  };
}

/** Adds the collector's hooks to existing ones; returns `base` untouched when there is no collector. */
export function withToolUsageHooks(base: Hooks | undefined, collector: ToolUsageCollector | undefined): Hooks | undefined {
  if (!collector) return base;
  const merged: Hooks = { ...(base ?? {}) };
  for (const [event, matchers] of Object.entries(collector.hooks()) as [HookEvent, HookCallbackMatcher[]][]) {
    merged[event] = [...(merged[event] ?? []), ...matchers];
  }
  return merged;
}

let warned = false;

/** Appends one line next to the cost ledger. Best effort: warns once per process, never throws. */
export function appendToolUsage(ledgerPath: string, record: ToolUsageRecord, warn: (msg: string) => void = console.warn): void {
  try {
    appendFileSync(join(dirname(ledgerPath), TOOL_USAGE_FILE), JSON.stringify(record) + '\n');
  } catch (err) {
    if (warned) return;
    warned = true;
    warn(`Failed to write ${TOOL_USAGE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
