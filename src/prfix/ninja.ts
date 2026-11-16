import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** How many times a caller may ask Ninja for an ID before giving up on one object. */
export const NINJA_MAX_ASSIGN_ATTEMPTS = 5;

const ASSIGN_TOOL = 'ninja_assignObjectId';
const UNASSIGN_TOOL = 'ninja_unassignObjectId';
/** `npx -y` downloads the server on first use, which can outlast a normal call timeout. */
const MIN_CONNECT_TIMEOUT_MS = 120_000;
/** How much of the child's stderr a connect failure quotes. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * The Object ID Ninja MCP server (`@vjeko.com/al-object-id-ninja-mcp`), driven
 * directly from pipeline code — no LLM in the path. Assigning *commits* the ID
 * in Ninja's backend, so a caller that ends up not using one must unassign it.
 */
export interface NinjaClient {
  assign(objectType: string, targetFilePath: string): Promise<number>;
  unassign(objectType: string, objectId: number, targetFilePath: string): Promise<void>;
  close(): Promise<void>;
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function numericField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The target path as the server might echo it: both separator forms, and the bare file name. */
function pathForms(targetFilePath: string): string[] {
  const forward = targetFilePath.replace(/\\/g, '/');
  const back = targetFilePath.replace(/\//g, '\\');
  const base = forward.slice(forward.lastIndexOf('/') + 1);
  // Longest first, so the full path is removed before its basename could split it.
  return [...new Set([targetFilePath, forward, back, base].filter((f) => f !== ''))].sort(
    (a, b) => b.length - a.length,
  );
}

function uniqueIds(matches: Iterable<string>, excluded: Set<string>): string[] {
  return [...new Set(matches)].filter((m) => !excluded.has(m));
}

/**
 * Parse an assign tool result: structuredContent.id / .objectId if numeric,
 * else an integer of >= 5 digits in the text content. The live response shape
 * has never been observed (calling assign reserves a real ID), so this is
 * tolerant in what it reads and strict in what it accepts:
 *
 * - every echo of `targetFilePath` is stripped first, and no digit run that
 *   occurs in the path is ever a candidate — worktree paths carry a 5-digit PR
 *   id (`prfix-61400`), and an AL file name often carries the old object ID;
 * - a number right after `ID` / `objectId` wins over bare numbers;
 * - otherwise exactly one candidate must remain. Two candidates, or none, throw.
 */
export function parseAssignedId(result: ToolResult, targetFilePath?: string): number {
  const structured = numericField(result.structuredContent, 'id') ?? numericField(result.structuredContent, 'objectId');
  if (structured !== undefined) return structured;
  const raw = resultText(result);
  let text = raw;
  const excluded = new Set<string>();
  if (targetFilePath) {
    for (const form of pathForms(targetFilePath)) {
      text = text.replace(new RegExp(escapeRegExp(form), 'gi'), ' ');
    }
    for (const run of targetFilePath.match(/\d{5,}/g) ?? []) excluded.add(run);
  }
  const labelled = uniqueIds(
    [...text.matchAll(/(?:\bid|objectid)\b[^0-9]{0,10}(\d{5,})(?!\d)/gi)].map((m) => m[1] ?? ''),
    excluded,
  );
  const candidates =
    labelled.length > 0 ? labelled : uniqueIds(text.match(/(?<!\d)\d{5,}(?!\d)/g) ?? [], excluded);
  if (candidates.length === 1) return Number(candidates[0]);
  if (candidates.length === 0) {
    throw new Error(`ninja: could not find an assigned object ID in the response: ${raw || '(no text)'}`);
  }
  throw new Error(`ninja: ambiguous assign response, several candidate IDs (${candidates.join(', ')}): ${raw}`);
}

/**
 * Spawn parameters for the stdio server. Without `env` the SDK passes only its
 * short safe-list (`getDefaultEnvironment()`), which drops HTTPS_PROXY,
 * NODE_EXTRA_CA_CERTS, npm_config_* and the like — and `npx -y` needs those to
 * download the server behind a proxy. So the whole environment is passed.
 */
export function ninjaStdioParams(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): StdioServerParameters {
  const passed: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') passed[k] = v;
  return { command, args, env: passed, stderr: 'pipe' };
}

export function createNinjaClient(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  /** Test seam: replaces the stdio transport that would spawn `command args`. */
  transport?: Transport;
}): NinjaClient {
  const commandLine = [opts.command, ...opts.args].join(' ');
  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;

  function connect(): Promise<Client> {
    if (!connecting) {
      connecting = (async () => {
        const c = new Client({ name: 'devops-coder-fix-pr', version: '0.1.0' });
        let stderrTail = '';
        let transport: Transport;
        if (opts.transport) {
          transport = opts.transport;
        } else {
          const stdio = new StdioClientTransport(ninjaStdioParams(opts.command, opts.args));
          // Piped stderr must be drained or a chatty child blocks on a full pipe;
          // the tail is kept for the connect-failure message.
          stdio.stderr?.on('data', (chunk: Buffer | string) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
          });
          transport = stdio;
        }
        try {
          await c.connect(transport, { timeout: Math.max(opts.timeoutMs, MIN_CONNECT_TIMEOUT_MS) });
        } catch (e) {
          connecting = undefined;
          await c.close().catch(() => {});
          const cause = e instanceof Error ? e.message : String(e);
          const tail = stderrTail.trim();
          throw new Error(
            `ninja: could not start "${commandLine}" (NINJA_MCP_COMMAND): ${cause}` +
              (tail ? `\nserver stderr (tail):\n${tail}` : ''),
          );
        }
        client = c;
        return c;
      })();
    }
    return connecting;
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const c = await connect();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`ninja: ${tool} timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    });
    try {
      // The SDK's own request timeout is set past ours so the race decides the message.
      const result = (await Promise.race([
        c.callTool({ name: tool, arguments: args }, undefined, { timeout: opts.timeoutMs + 5_000 }),
        timeout,
      ])) as ToolResult;
      if (result.isError) throw new Error(`ninja: ${resultText(result) || `${tool} failed`}`);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async assign(objectType, targetFilePath) {
      return parseAssignedId(await call(ASSIGN_TOOL, { objectType, targetFilePath }), targetFilePath);
    },
    async unassign(objectType, objectId, targetFilePath) {
      await call(UNASSIGN_TOOL, { objectType, objectId, targetFilePath });
    },
    async close() {
      const c = client;
      client = undefined;
      connecting = undefined;
      if (c) await c.close();
    },
  };
}
