import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** How many times a caller may ask Ninja for an ID before giving up on one object. */
export const NINJA_MAX_ASSIGN_ATTEMPTS = 5;

const ASSIGN_TOOL = 'ninja_assignObjectId';
const UNASSIGN_TOOL = 'ninja_unassignObjectId';
/** `npx -y` downloads the server on first use, which can outlast a normal call timeout. */
const MIN_CONNECT_TIMEOUT_MS = 120_000;
/** How much of the child's stderr a connect failure quotes. */
const STDERR_TAIL_CHARS = 2_000;
/** How much of an unparseable assign response the error quotes. */
const RAW_RESPONSE_CHARS = 500;

/**
 * The Object ID Ninja MCP server (`@vjeko.com/al-object-id-ninja-mcp`), driven
 * directly from pipeline code — no LLM in the path. Assigning *commits* the ID
 * in Ninja's backend, so a caller that ends up not using one must unassign it.
 */
export interface NinjaClient {
  /**
   * `rangeName` is the `description` of a range in the app's `.objidconfig`;
   * Ninja requires one when several ranges apply. Throws NinjaAssignRefusedError
   * when Ninja hands out no ID (an error result, or `available: false`).
   */
  assign(objectType: string, targetFilePath: string, rangeName?: string): Promise<number>;
  unassign(objectType: string, objectId: number, targetFilePath: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ninja answered an assign without an ID: an error result (the range is
 * exhausted, a range name is needed or unknown, ...) or `available: false`.
 * Nothing was reserved, so there is nothing to release.
 */
export class NinjaAssignRefusedError extends Error {
  constructor(
    readonly serverText: string,
    message: string,
  ) {
    super(message);
    this.name = 'NinjaAssignRefusedError';
  }
}

/** `available: false` in structuredContent, or in a text content that is JSON. */
function saysUnavailable(result: ToolResult): boolean {
  const flag = (v: unknown) =>
    v !== null && typeof v === 'object' && (v as Record<string, unknown>).available === false;
  if (flag(result.structuredContent)) return true;
  for (const c of result.content ?? []) {
    if (c.type !== 'text' || typeof c.text !== 'string' || !c.text.trim().startsWith('{')) continue;
    try {
      if (flag(JSON.parse(c.text))) return true;
    } catch {
      // Not JSON: not an availability answer.
    }
  }
  return false;
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

/** The whole response as text (content, then structuredContent as JSON), cut to `RAW_RESPONSE_CHARS`. */
function rawResponse(result: ToolResult): string {
  const parts = [resultText(result)];
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const raw = parts.filter((s) => s !== '').join(' | ') || '(empty)';
  return raw.length > RAW_RESPONSE_CHARS ? `${raw.slice(0, RAW_RESPONSE_CHARS)}... (${raw.length} chars)` : raw;
}

/**
 * Variables the Ninja child may see on top of the SDK's own safe-list
 * (`DEFAULT_INHERITED_ENV_VARS`, i.e. `getDefaultEnvironment()`): what `npx -y`
 * needs to download the package behind a proxy or a TLS-inspecting gateway.
 * Plus every key matching `NINJA_ENV_ALLOWED_PREFIXES`.
 */
export const NINJA_ENV_ALLOWLIST: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
export const NINJA_ENV_ALLOWED_PREFIXES: readonly string[] = ['npm_config_', 'NPM_CONFIG_'];

/**
 * The git identity the Ninja server reports to its backend. The backend
 * authorizes by the caller's git email (`USER_NOT_AUTHORIZED` with `gitEmail`),
 * which the server reads from git config. Without this it reads whatever the
 * shared target clone or the container's global config says, which on the VM
 * is the agents' `claude-agent@continia.local`.
 */
export interface NinjaGitIdentity {
  email: string;
  name?: string;
}

/**
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (git >= 2.31) outrank every git config
 * file, so `git config user.email` in any repo answers with this identity; the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` pair covers a server that reads those
 * instead. Only the child sees them — the shared clone is never touched.
 */
function gitIdentityEnv(identity: NinjaGitIdentity): Record<string, string> {
  const entries: [string, string][] = [['user.email', identity.email]];
  if (identity.name) entries.push(['user.name', identity.name]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_AUTHOR_EMAIL = identity.email;
  env.GIT_COMMITTER_EMAIL = identity.email;
  if (identity.name) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_COMMITTER_NAME = identity.name;
  }
  return env;
}

/**
 * The backend refused the caller rather than the range: HTTP 401/403, Ninja's
 * `USER_NOT_AUTHORIZED`, or a missing/invalid auth key. Trying another range
 * cannot help, so the stage stops on it instead of reporting the ranges as full.
 */
export function isNinjaAuthError(text: string): boolean {
  return /\bHTTP 40[13]\b|USER_NOT_AUTHORIZED|\bunauthori[sz]ed\b|\bforbidden\b|auth(?:orization)? key/i.test(text);
}

/**
 * Spawn parameters for the stdio server. The child is a third-party package
 * fetched by `npx -y`, so it gets an allowlisted environment — never the whole
 * process env, which holds AZURE_DEVOPS_PAT, ANTHROPIC_*, CONTINIA_API_TOKEN
 * and the rest. (The SDK's own default would drop the proxy/CA/npm settings.)
 */
export function ninjaStdioParams(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  gitIdentity?: NinjaGitIdentity,
): StdioServerParameters {
  const passed: Record<string, string> = {};
  if (gitIdentity) Object.assign(passed, gitIdentityEnv(gitIdentity));
  // Named lookups, not an iteration, so Windows' case-insensitive process.env still finds `Path` as PATH.
  for (const key of [...DEFAULT_INHERITED_ENV_VARS, ...NINJA_ENV_ALLOWLIST]) {
    const v = env[key];
    // The SDK skips values starting with '()' (exported shell functions); so do we.
    if (typeof v === 'string' && !v.startsWith('()')) passed[key] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && NINJA_ENV_ALLOWED_PREFIXES.some((p) => k.startsWith(p))) passed[k] = v;
  }
  return { command, args, env: passed, stderr: 'pipe' };
}

export function createNinjaClient(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  /** The git identity the server reports to the Ninja backend (`NINJA_GIT_EMAIL`). */
  gitIdentity?: NinjaGitIdentity;
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
          const stdio = new StdioClientTransport(ninjaStdioParams(opts.command, opts.args, process.env, opts.gitIdentity));
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

  /** The raw result, error results included; `call` turns an error into a throw. */
  async function callRaw(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
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
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await callRaw(tool, args);
    if (result.isError) throw new Error(`ninja: ${resultText(result) || `${tool} failed`}`);
    return result;
  }

  return {
    async assign(objectType, targetFilePath, rangeName) {
      const args: Record<string, unknown> = { objectType, targetFilePath };
      if (rangeName !== undefined) args.rangeName = rangeName;
      const result = await callRaw(ASSIGN_TOOL, args);
      if (result.isError || saysUnavailable(result)) {
        const text = resultText(result) || rawResponse(result);
        throw new NinjaAssignRefusedError(text, `ninja: ${result.isError ? text || `${ASSIGN_TOOL} failed` : `no ${objectType} ID available: ${text}`}`);
      }
      try {
        return parseAssignedId(result, targetFilePath);
      } catch (err) {
        // The server has answered, so an ID may already be reserved: quote the response so an operator can find it.
        const reason = (err instanceof Error ? err.message : String(err)).split(':')[1]?.trim() ?? 'unreadable';
        throw new Error(
          `ninja: could not read the assigned ${objectType} ID for ${targetFilePath} (${reason}); ` +
            `an ID may already be reserved, release it by hand. Raw response: ${rawResponse(result)}`,
        );
      }
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
