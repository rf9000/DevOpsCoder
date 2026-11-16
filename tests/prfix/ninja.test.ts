import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  NinjaAssignRefusedError,
  createNinjaClient,
  ninjaStdioParams,
  parseAssignedId,
} from '../../src/prfix/ninja.ts';

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

interface FakeOpts {
  assign?: (args: { objectType: string; targetFilePath: string; rangeName?: string }) => ToolText;
}

async function fakeServer(opts: FakeOpts = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const server = new McpServer({ name: 'fake-ninja', version: '0.0.0' });
  server.registerTool(
    'ninja_assignObjectId',
    { inputSchema: { objectType: z.string(), targetFilePath: z.string(), rangeName: z.string().optional() } },
    async (args) => {
      calls.push({ tool: 'ninja_assignObjectId', args });
      return opts.assign
        ? opts.assign(args)
        : { content: [{ type: 'text' as const, text: 'Assigned codeunit ID 72918790' }] };
    },
  );
  server.registerTool(
    'ninja_unassignObjectId',
    { inputSchema: { objectType: z.string(), objectId: z.number(), targetFilePath: z.string() } },
    async (args) => {
      calls.push({ tool: 'ninja_unassignObjectId', args });
      return { content: [{ type: 'text' as const, text: 'Unassigned' }] };
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { calls, clientTransport, server };
}

describe('createNinjaClient', () => {
  it('assign calls ninja_assignObjectId with objectType and targetFilePath and returns the id', async () => {
    const { calls, clientTransport } = await fakeServer();
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    const id = await client.assign('codeunit', 'C:/repo/app/src/Foo.Codeunit.al');
    expect(id).toBe(72918790);
    expect(calls).toEqual([
      {
        tool: 'ninja_assignObjectId',
        args: { objectType: 'codeunit', targetFilePath: 'C:/repo/app/src/Foo.Codeunit.al' },
      },
    ]);
    await client.close();
  });

  it('isError result throws with the server text', async () => {
    const { clientTransport } = await fakeServer({
      assign: () => ({ content: [{ type: 'text', text: 'No ranges available' }], isError: true }),
    });
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    await expect(client.assign('table', 'C:/repo/app/src/T.al')).rejects.toThrow('ninja: No ranges available');
    await client.close();
  });

  it('passes rangeName only when given', async () => {
    const { calls, clientTransport } = await fakeServer();
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    await client.assign('codeunit', 'C:/a.al', 'From 72918625 to 72918824');
    await client.assign('codeunit', 'C:/a.al');
    expect(calls.map((c) => c.args)).toEqual([
      { objectType: 'codeunit', targetFilePath: 'C:/a.al', rangeName: 'From 72918625 to 72918824' },
      { objectType: 'codeunit', targetFilePath: 'C:/a.al' },
    ]);
    await client.close();
  });

  it('an error result is a NinjaAssignRefusedError carrying the server text', async () => {
    const text = 'Error: Multiple ranges available for codeunit. You must specify which range to use via the rangeName parameter.';
    const { clientTransport } = await fakeServer({ assign: () => ({ content: [{ type: 'text', text }], isError: true }) });
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    const err = await client.assign('codeunit', 'C:/a.al').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NinjaAssignRefusedError);
    expect((err as NinjaAssignRefusedError).serverText).toBe(text);
    await client.close();
  });

  it('available: false is a NinjaAssignRefusedError, in structuredContent or as JSON text', async () => {
    for (const result of [
      { content: [{ type: 'text' as const, text: 'none' }], structuredContent: { available: false } },
      { content: [{ type: 'text' as const, text: '{"available":false,"id":0}' }] },
    ]) {
      const { clientTransport } = await fakeServer({ assign: () => result });
      const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
      await expect(client.assign('codeunit', 'C:/a.al', 'R')).rejects.toBeInstanceOf(NinjaAssignRefusedError);
      await client.close();
    }
  });

  it('an unparseable assign response throws with the raw text, truncated, so the ID can be released by hand', async () => {
    const raw = 'Assigned 50100 in range 50000..59999 ' + 'x'.repeat(600);
    const { clientTransport } = await fakeServer({ assign: () => ({ content: [{ type: 'text', text: raw }] }) });
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    const err = (await client.assign('codeunit', 'C:/repo/app/src/Foo.Codeunit.al').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Assigned 50100 in range 50000..59999');
    expect(err.message).toContain(raw.slice(0, 500));
    expect(err.message).not.toContain(raw.slice(0, 501));
    expect(err.message).toContain('release it by hand');
    expect(err.message).toContain('C:/repo/app/src/Foo.Codeunit.al');
    await client.close();
  });

  it('unassign passes objectId', async () => {
    const { calls, clientTransport } = await fakeServer();
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000, transport: clientTransport });
    await client.unassign('codeunit', 72918790, 'C:/repo/app/src/Foo.Codeunit.al');
    expect(calls).toEqual([
      {
        tool: 'ninja_unassignObjectId',
        args: { objectType: 'codeunit', objectId: 72918790, targetFilePath: 'C:/repo/app/src/Foo.Codeunit.al' },
      },
    ]);
    await client.close();
  });

  it('does not connect until the first call', async () => {
    const { clientTransport } = await fakeServer();
    let starts = 0;
    const originalStart = clientTransport.start.bind(clientTransport);
    clientTransport.start = async () => {
      starts++;
      await originalStart();
    };
    const client = createNinjaClient({
      command: 'x',
      args: [],
      timeoutMs: 5000,
      transport: clientTransport as Transport,
    });
    expect(starts).toBe(0);
    await client.assign('codeunit', 'C:/repo/app/src/Foo.Codeunit.al');
    expect(starts).toBe(1);
    await client.close();
  });

  it('close is a no-op when never connected', async () => {
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 5000 });
    await client.close();
  });

  it('times out a call that never answers', async () => {
    const server = new McpServer({ name: 'slow', version: '0.0.0' });
    server.registerTool(
      'ninja_assignObjectId',
      { inputSchema: { objectType: z.string(), targetFilePath: z.string() } },
      () => new Promise<ToolText>(() => {}),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = createNinjaClient({ command: 'x', args: [], timeoutMs: 50, transport: clientTransport });
    await expect(client.assign('codeunit', 'C:/a.al')).rejects.toThrow(
      'ninja: ninja_assignObjectId timed out after 50 ms',
    );
    await client.close();
  });

  it('connect failure names the command', async () => {
    const client = createNinjaClient({
      command: 'definitely-not-a-real-command-ninja-xyz',
      args: ['--flag'],
      timeoutMs: 10_000,
    });
    let err: unknown;
    try {
      await client.assign('codeunit', 'C:/a.al');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('NINJA_MCP_COMMAND');
    expect(msg).toContain('definitely-not-a-real-command-ninja-xyz --flag');
    expect(msg).toStartWith('ninja: could not start');
    await client.close();
  });

  it('connect failure quotes the tail of the server stderr', async () => {
    const client = createNinjaClient({
      command: process.execPath,
      // The stderr text is assembled at runtime so it cannot reach the message via the echoed command line.
      args: ['-e', "console.error(['ninja', 'boom'].join('-') + ': 403 from registry'); process.exit(3)"],
      timeoutMs: 10_000,
    });
    let msg = '';
    try {
      await client.assign('codeunit', 'C:/a.al');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('NINJA_MCP_COMMAND');
    expect(msg).toContain('ninja-boom: 403 from registry');
    await client.close();
  });
});

describe('ninjaStdioParams', () => {
  it('passes only allowlisted variables and pipes stderr', () => {
    const p = ninjaStdioParams('cmd', ['/c', 'npx'], {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
      npm_config_registry: 'https://registry.example',
      NPM_CONFIG_CACHE: '/tmp/npm',
      AZURE_DEVOPS_PAT: 'secret-pat',
      ANTHROPIC_API_KEY: 'secret-key',
      CONTINIA_API_TOKEN: 'secret-token',
      SSL_CERT_FILE: undefined,
    });
    expect(p.command).toBe('cmd');
    expect(p.args).toEqual(['/c', 'npx']);
    expect(p.env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
      npm_config_registry: 'https://registry.example',
      NPM_CONFIG_CACHE: '/tmp/npm',
    });
    expect(p.stderr).toBe('pipe');
  });

  it('defaults to process.env: the proxy passes, secrets do not', () => {
    const saved = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      AZURE_DEVOPS_PAT: process.env.AZURE_DEVOPS_PAT,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.HTTPS_PROXY = 'http://sentinel-proxy:3128';
    process.env.AZURE_DEVOPS_PAT = 'sentinel-pat';
    process.env.ANTHROPIC_API_KEY = 'sentinel-key';
    try {
      const env = ninjaStdioParams('npx', []).env ?? {};
      expect(env.HTTPS_PROXY).toBe('http://sentinel-proxy:3128');
      expect(env.AZURE_DEVOPS_PAT).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.values(env)).not.toContain('sentinel-pat');
      expect(Object.values(env)).not.toContain('sentinel-key');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('parseAssignedId', () => {
  const WT = 'C:\\wt\\prfix-61400\\banking-w1\\src\\Tab50100.Foo.al';

  it('ignores an echoed target path and takes the number after ID', () => {
    const text = `Assigned table ID 72918790 for ${WT} (C:/wt/prfix-61400/banking-w1/src/Tab50100.Foo.al)`;
    expect(parseAssignedId({ content: [{ type: 'text', text }] }, WT)).toBe(72918790);
  });

  it('never returns a number from the target path when the text echoes only the path', () => {
    const forward = WT.replace(/\\/g, '/');
    expect(() => parseAssignedId({ content: [{ type: 'text', text: `Working on ${forward}` }] }, WT)).toThrow(/ninja/);
    expect(() => parseAssignedId({ content: [{ type: 'text', text: `Working on ${WT}` }] }, WT)).toThrow(/ninja/);
    // A path whose only 5+ digit run is the PR id: the single-candidate rule alone would return 61400.
    const lone = 'C:\\wt\\prfix-61400\\app\\src\\Foo.Codeunit.al';
    expect(() =>
      parseAssignedId({ content: [{ type: 'text', text: 'Working on C:/wt/prfix-61400/app/src/Foo.Codeunit.al' }] }, lone),
    ).toThrow(/ninja/);
    // A partial echo (the worktree dir and the basename separately) is still not a source of IDs.
    expect(() =>
      parseAssignedId({ content: [{ type: 'text', text: 'Saved in C:\\wt\\prfix-61400 as Tab50100.Foo.al' }] }, WT),
    ).toThrow(/ninja/);
  });

  it('prefers a number labelled ID over other numbers', () => {
    expect(parseAssignedId({ content: [{ type: 'text', text: 'Range 50000..59999: object ID 50123' }] })).toBe(50123);
    expect(parseAssignedId({ content: [{ type: 'text', text: '{"objectId": 70000002, "range": 70099999}' }] })).toBe(
      70000002,
    );
  });

  it('parseAssignedId prefers structuredContent.id', () => {
    expect(
      parseAssignedId({
        structuredContent: { id: 50123 },
        content: [{ type: 'text', text: 'Assigned 72918790' }],
      }),
    ).toBe(50123);
  });

  it('accepts structuredContent.objectId', () => {
    expect(parseAssignedId({ structuredContent: { objectId: 50124 } })).toBe(50124);
  });

  it('falls back to the text when structuredContent has no numeric id', () => {
    expect(
      parseAssignedId({ structuredContent: { id: 'x' }, content: [{ type: 'text', text: 'ID 70000001 for table' }] }),
    ).toBe(70000001);
  });

  it('ignores integers shorter than 5 digits', () => {
    expect(parseAssignedId({ content: [{ type: 'text', text: 'range 1 of 2: assigned 50100' }] })).toBe(50100);
  });

  it('parseAssignedId throws on two candidate integers', () => {
    expect(() => parseAssignedId({ content: [{ type: 'text', text: 'Assigned 50100 in range 50000..59999' }] })).toThrow(
      /ninja/,
    );
  });

  it('throws when no id can be found', () => {
    expect(() => parseAssignedId({ content: [{ type: 'text', text: 'done' }] })).toThrow(/ninja/);
    expect(() => parseAssignedId({})).toThrow(/ninja/);
  });
});
