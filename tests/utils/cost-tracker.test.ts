import { describe, it, expect } from 'bun:test';
import { createCostTracker } from '../../src/utils/cost-tracker.ts';
import type { PipelineState } from '../../src/types/index.ts';

function makeState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi',
    startedAt: '',
    updatedAt: '',
    currentStage: null,
    history: [],
    attempts: {},
    outputs: {},
  };
}

describe('createCostTracker', () => {
  it('fresh state initializes state.outputs.cost with zeros', () => {
    const state = makeState();
    createCostTracker(state);
    expect(state.outputs.cost).toEqual({ total: 0, perStage: {} });
  });

  it('add(stage, usd) accumulates per-stage', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.42);
    tracker.add('coder', 0.18);
    expect(tracker.perStage()['coder']).toBeCloseTo(0.6, 4);
  });

  it('add accumulates total across stages', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('analyzer', 0.10);
    tracker.add('coder', 0.50);
    tracker.add('reviewer', 0.25);
    expect(tracker.total()).toBeCloseTo(0.85, 4);
  });

  it('total() and perStage() on empty return 0 and {}', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    expect(tracker.total()).toBe(0);
    expect(tracker.perStage()).toEqual({});
  });

  it('idempotent re-entry preserves existing PipelineCostInfo', () => {
    const state = makeState();
    state.outputs.cost = { total: 1.00, perStage: { analyzer: 1.00 } };
    const tracker = createCostTracker(state);
    expect(tracker.total()).toBe(1.00);
    expect(tracker.perStage()['analyzer']).toBe(1.00);
    tracker.add('coder', 0.25);
    expect(tracker.total()).toBeCloseTo(1.25, 4);
    expect(tracker.perStage()['analyzer']).toBe(1.00);
    expect(tracker.perStage()['coder']).toBeCloseTo(0.25, 4);
  });

  it('perStage() returns a defensive copy', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.5);
    const snapshot = tracker.perStage();
    snapshot['coder'] = 999;
    // Internal state must be unchanged
    expect(tracker.perStage()['coder']).toBeCloseTo(0.5, 4);
  });
});
