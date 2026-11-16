import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createNinjaClient, parseAssignedId } from '../../src/prfix/ninja.ts';

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean };

interface FakeOpts {
  assign?: (args: { objectType: string; targetFilePath: string }) => ToolText;
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
});

describe('parseAssignedId', () => {
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
