import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { PipelineState } from '../../src/types/index.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-state-'));
}

function makeState(workItemId: number, overrides: Partial<PipelineState> = {}): PipelineState {
  const ts = new Date('2026-05-01T10:00:00.000Z').toISOString();
  return {
    workItemId,
    slug: `wi-${workItemId}`,
    startedAt: ts,
    updatedAt: ts,
    currentStage: 'analyzer',
    history: [],
    attempts: {},
    outputs: {},
    ...overrides,
  };
}

describe('PipelineStateStore', () => {
  it('save then load returns the same state shape', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    const state = makeState(101);

    store.save(state);

    const loaded = store.load(101);
    expect(loaded).not.toBeNull();
    expect(loaded?.workItemId).toBe(101);
    expect(loaded?.slug).toBe('wi-101');
    expect(loaded?.currentStage).toBe('analyzer');
  });

  it('save updates updatedAt', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    const state = makeState(101, { updatedAt: '2020-01-01T00:00:00.000Z' });
    store.save(state);
    const loaded = store.load(101);
    expect(loaded?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(loaded!.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('load returns null when the file does not exist', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    expect(store.load(999)).toBeNull();
  });

  it('load returns null when the file contains corrupt JSON', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    writeFileSync(join(dir, '101.json'), '{{not json}}', 'utf-8');
    expect(store.load(101)).toBeNull();
  });

  it('load returns null when the file is missing the workItemId field', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    writeFileSync(join(dir, '101.json'), JSON.stringify({ slug: 'no-id' }), 'utf-8');
    expect(store.load(101)).toBeNull();
  });

  it('listAll returns every saved pipeline state', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    store.save(makeState(102));
    store.save(makeState(103));

    const all = store.listAll();
    const ids = all.map((s) => s.workItemId).sort((a, b) => a - b);
    expect(ids).toEqual([101, 102, 103]);
  });

  it('listAll skips files that do not end with .json', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    writeFileSync(join(dir, 'README.txt'), 'ignore me', 'utf-8');
    expect(store.listAll().length).toBe(1);
  });

  it('listResumable excludes completed, terminal-failed, and cancelled states', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101)); // resumable
    store.save(makeState(102, { completedAt: '2026-05-01T11:00:00.000Z' }));
    store.save(makeState(103, { terminalError: { stage: 'coder', message: 'x', at: '2026-05-01T11:00:00.000Z' } }));
    store.save(makeState(104, { cancelled: true }));
    store.save(makeState(105)); // resumable

    const resumable = store.listResumable();
    const ids = resumable.map((s) => s.workItemId).sort((a, b) => a - b);
    expect(ids).toEqual([101, 105]);
  });

  it('listResumable excludes states with state.rejection set (analyzer-rejected WIs wait for human re-tag)', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(201)); // fresh
    store.save(makeState(202, {
      rejection: {
        reasons: ['vague'],
        summary: 'not ready',
        stage: 'analyzer',
        at: '2026-01-01T00:01:00Z',
      },
    }));

    const resumable = store.listResumable();
    const ids = resumable.map((s) => s.workItemId).sort();
    expect(ids).toEqual([201]);
  });

  it('delete removes the on-disk file', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    expect(store.load(101)).not.toBeNull();
    store.delete(101);
    expect(store.load(101)).toBeNull();
  });

  it('delete is idempotent when the file does not exist', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    expect(() => store.delete(999)).not.toThrow();
  });

  it('save creates the state directory if it does not exist', () => {
    const parent = makeTmpDir();
    const dir = join(parent, 'nested', 'state');
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    const raw = readFileSync(join(dir, '101.json'), 'utf-8');
    expect(JSON.parse(raw).workItemId).toBe(101);
  });
});
