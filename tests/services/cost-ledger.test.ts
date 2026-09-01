import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCostLedger, type CostRecord } from '../../src/services/cost-ledger.ts';
import { createLogger } from '../../src/utils/logger.ts';

describe('createCostLedger', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    path = join(dir, 'cost-ledger.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function read(): CostRecord[] {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as CostRecord);
  }

  it('appends one JSON object per line', () => {
    const ledger = createCostLedger({ path, logger: createLogger() });
    ledger.record({ at: '2026-09-01T10:00:00Z', workItemId: 1, outcome: 'completed', costUsd: 8.45 });
    ledger.record({ at: '2026-09-01T11:00:00Z', workItemId: 2, outcome: 'failed', costUsd: 2.1 });

    const rows = read();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ workItemId: 1, outcome: 'completed', costUsd: 8.45 });
    expect(rows[1]).toMatchObject({ workItemId: 2, outcome: 'failed', costUsd: 2.1 });
  });

  it('carries the PR id and url when one was opened', () => {
    const ledger = createCostLedger({ path, logger: createLogger() });
    ledger.record({
      at: '2026-09-01T10:00:00Z',
      workItemId: 77843,
      outcome: 'completed',
      costUsd: 8.45,
      prId: 42,
      prUrl: 'https://dev.azure.com/o/p/_git/r/pullrequest/42',
    });
    expect(read()[0]).toMatchObject({ workItemId: 77843, prId: 42 });
  });

  it('creates the parent directory when it does not exist yet', () => {
    const nested = join(dir, 'a', 'b', 'ledger.jsonl');
    createCostLedger({ path: nested, logger: createLogger() }).record({
      at: 'x', workItemId: 1, outcome: 'completed', costUsd: 0,
    });
    expect(existsSync(nested)).toBe(true);
  });

  it('never throws when the path is unwritable — bookkeeping must not fail a run', () => {
    // A directory where a file is expected: append always fails.
    const ledger = createCostLedger({ path: dir, logger: createLogger() });
    expect(() => {
      ledger.record({ at: 'x', workItemId: 1, outcome: 'completed', costUsd: 1 });
      ledger.record({ at: 'y', workItemId: 2, outcome: 'completed', costUsd: 2 });
    }).not.toThrow();
  });

  it('warns only once per process for a persistently bad path', () => {
    const warnings: string[] = [];
    const logger = { ...createLogger(), warn: (m: string) => warnings.push(m) };
    const ledger = createCostLedger({ path: dir, logger });
    ledger.record({ at: 'x', workItemId: 1, outcome: 'completed', costUsd: 1 });
    ledger.record({ at: 'y', workItemId: 2, outcome: 'completed', costUsd: 2 });
    ledger.record({ at: 'z', workItemId: 3, outcome: 'completed', costUsd: 3 });
    expect(warnings).toHaveLength(1);
  });

  it('emits parseable JSONL that survives a round trip', () => {
    const ledger = createCostLedger({ path, logger: createLogger() });
    ledger.record({
      at: '2026-09-01T10:00:00Z',
      workItemId: 1,
      outcome: 'completed',
      costUsd: 8.4512,
      perStage: {
        analyzer: { usd: 0.31, calls: 1, inputTokens: 20, outputTokens: 2, turns: 3, models: ['claude-sonnet-5'] },
        'revision-loop': { usd: 5.62, calls: 4, inputTokens: 900, outputTokens: 80, turns: 40, models: ['claude-opus-5'] },
        'test-author': { usd: 2.52, calls: 1, inputTokens: 300, outputTokens: 30, turns: 9, models: ['claude-opus-5'] },
      },
    });
    const row = read()[0]!;
    expect(row.perStage?.['revision-loop']?.usd).toBe(5.62);
    expect(row.perStage?.['revision-loop']?.models).toEqual(['claude-opus-5']);
  });
});
