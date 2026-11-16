import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** How many times a caller may ask Ninja for an ID before giving up on one object. */
export const NINJA_MAX_ASSIGN_ATTEMPTS = 5;

const ASSIGN_TOOL = 'ninja_assignObjectId';
const UNASSIGN_TOOL = 'ninja_unassignObjectId';

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

/**
 * Parse an assign tool result: structuredContent.id / .objectId if numeric,
 * else the single integer of >= 5 digits in the text content. Throws if none
 * or several. The live response shape has never been observed (calling assign
 * reserves a real ID), so this is deliberately tolerant — and deliberately
 * refuses to guess between two candidates.
 */
export function parseAssignedId(result: ToolResult): number {
  const structured = numericField(result.structuredContent, 'id') ?? numericField(result.structuredContent, 'objectId');
  if (structured !== undefined) return structured;
  const text = resultText(result);
  const candidates = [...new Set(text.match(/(?<!\d)\d{5,}(?!\d)/g) ?? [])];
  if (candidates.length === 1) return Number(candidates[0]);
  if (candidates.length === 0) {
    throw new Error(`ninja: could not find an assigned object ID in the response: ${text || '(no text)'}`);
  }
  throw new Error(
    `ninja: ambiguous assign response, several candidate IDs (${candidates.join(', ')}): ${text}`,
  );
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
        const transport =
          opts.transport ?? new StdioClientTransport({ command: opts.command, args: opts.args });
        try {
          await c.connect(transport);
        } catch (e) {
          connecting = undefined;
          await c.close().catch(() => {});
          const cause = e instanceof Error ? e.message : String(e);
          throw new Error(`ninja: could not start "${commandLine}" (NINJA_MCP_COMMAND): ${cause}`);
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
      return parseAssignedId(await call(ASSIGN_TOOL, { objectType, targetFilePath }));
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
