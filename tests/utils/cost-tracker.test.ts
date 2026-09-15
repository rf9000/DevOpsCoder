import { describe, it, expect } from 'bun:test';
import {
  assertWithinCostCap,
  createCostTracker,
  normalizePerStage,
} from '../../src/utils/cost-tracker.ts';
import type { AgentUsage, PipelineState, StepSpend } from '../../src/types/index.ts';

function makeState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi',
    startedAt: '',
    updatedAt: '',
    currentStage: null,
    history: [],
    outputs: {},
  };
}

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({
  inputTokens: 1000,
  outputTokens: 100,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  turns: 5,
  model: 'claude-opus-5',
  ...over,
});

describe('createCostTracker', () => {
  it('fresh state initializes state.outputs.cost with zeros', () => {
    const state = makeState();
    createCostTracker(state);
    expect(state.outputs.cost).toEqual({ total: 0, perStage: {} });
  });

  it('add(step, usd) accumulates usd per step', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.42);
    tracker.add('coder', 0.18);
    expect(tracker.perStage()['coder']!.usd).toBeCloseTo(0.6, 4);
  });

  it('add counts one call per invocation', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.42);
    tracker.add('coder', 0.18);
    expect(tracker.perStage()['coder']!.calls).toBe(2);
  });

  it('add accumulates tokens and turns from usage', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.4, usage({ inputTokens: 1000, outputTokens: 100, turns: 5 }));
    tracker.add('coder', 0.6, usage({ inputTokens: 2500, outputTokens: 250, turns: 7 }));
    const step = tracker.perStage()['coder']!;
    expect(step.inputTokens).toBe(3500);
    expect(step.outputTokens).toBe(350);
    expect(step.turns).toBe(12);
  });

  // `inputTokens` counts only what the cache did not serve, so a step whose
  // prompt is almost entirely cached reports a handful of input tokens against
  // a large bill. Without these two counters the dominant half of the spend has
  // nowhere to show up.
  it('add accumulates cache read and write tokens', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.4, usage({ cacheCreationInputTokens: 12_000, cacheReadInputTokens: 80_000 }));
    tracker.add('coder', 0.6, usage({ cacheCreationInputTokens: 500, cacheReadInputTokens: 95_000 }));
    const step = tracker.perStage()['coder']!;
    expect(step.cacheCreationInputTokens).toBe(12_500);
    expect(step.cacheReadInputTokens).toBe(175_000);
  });

  it('add records each distinct model once, in first-seen order', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.1, usage({ model: 'claude-opus-5' }));
    tracker.add('coder', 0.1, usage({ model: 'claude-opus-5' }));
    tracker.add('coder', 0.1, usage({ model: 'claude-sonnet-5' }));
    expect(tracker.perStage()['coder']!.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('add without usage still counts the call and leaves tokens at zero', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('reviewer', 0.3);
    const step = tracker.perStage()['reviewer']!;
    expect(step).toEqual({
      usd: 0.3,
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      turns: 0,
      models: [],
    });
  });

  it('add accumulates total across steps', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('analyzer', 0.1);
    tracker.add('coder', 0.5);
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
    state.outputs.cost = {
      total: 1.0,
      perStage: { analyzer: { usd: 1.0, calls: 1, inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 3, models: ['m'] } },
    };
    const tracker = createCostTracker(state);
    expect(tracker.total()).toBe(1.0);
    expect(tracker.perStage()['analyzer']!.usd).toBe(1.0);
    tracker.add('coder', 0.25);
    expect(tracker.total()).toBeCloseTo(1.25, 4);
    expect(tracker.perStage()['analyzer']!.usd).toBe(1.0);
    expect(tracker.perStage()['coder']!.usd).toBeCloseTo(0.25, 4);
  });

  // A state file written before per-step detail existed carries bare numbers.
  // Resuming such a WI must not crash and must not lose the recorded spend.
  it('normalizes a legacy bare-number perStage entry on load', () => {
    const state = makeState();
    state.outputs.cost = { total: 1.0, perStage: { analyzer: 1.0 } };
    const tracker = createCostTracker(state);
    expect(tracker.perStage()['analyzer']).toEqual({
      usd: 1.0,
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      turns: 0,
      models: [],
    });
  });

  it('adds onto a normalized legacy entry without losing its usd', () => {
    const state = makeState();
    state.outputs.cost = { total: 1.0, perStage: { coder: 1.0 } };
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.5, usage({ inputTokens: 40, outputTokens: 4, turns: 2 }));
    const step = tracker.perStage()['coder']!;
    expect(step.usd).toBeCloseTo(1.5, 4);
    expect(step.calls).toBe(2);
    expect(step.inputTokens).toBe(40);
  });

  it('writes the normalized shape through to state.outputs.cost', () => {
    const state = makeState();
    state.outputs.cost = { total: 1.0, perStage: { analyzer: 1.0 } };
    createCostTracker(state);
    const persisted = state.outputs.cost as { perStage: Record<string, StepSpend> };
    expect(persisted.perStage['analyzer']!.usd).toBe(1.0);
  });

  it('perStage() returns a copy whose entries cannot mutate internal state', () => {
    const state = makeState();
    const tracker = createCostTracker(state);
    tracker.add('coder', 0.5);
    const snapshot = tracker.perStage();
    snapshot['coder']!.usd = 999;
    delete snapshot['coder'];
    expect(tracker.perStage()['coder']!.usd).toBeCloseTo(0.5, 4);
  });
});

describe('normalizePerStage', () => {
  it('returns {} for a missing map', () => {
    expect(normalizePerStage(undefined)).toEqual({});
  });

  it('passes a already-normalized entry through unchanged', () => {
    const entry: StepSpend = {
      usd: 2,
      calls: 3,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      turns: 4,
      models: ['claude-opus-5'],
    };
    expect(normalizePerStage({ coder: entry })['coder']).toEqual(entry);
  });

  it('wraps a bare number as a single-call entry with no token detail', () => {
    expect(normalizePerStage({ coder: 1.25 })['coder']).toEqual({
      usd: 1.25,
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      turns: 0,
      models: [],
    });
  });

  it('drops an entry that is neither a number nor an object', () => {
    expect(normalizePerStage({ coder: 'nonsense' })).toEqual({});
  });
});

describe('assertWithinCostCap', () => {
  const withTotal = (total: number): PipelineState => {
    const s = makeState();
    s.outputs.cost = { total, perStage: {} };
    return s;
  };

  it('throws once the total is over the cap, naming the stage', () => {
    expect(() => assertWithinCostCap(withTotal(29.06), 20, 'revision-loop')).toThrow(
      /revision-loop/,
    );
  });

  it('does not throw at exactly the cap', () => {
    expect(() => assertWithinCostCap(withTotal(20), 20, 'revision-loop')).not.toThrow();
  });

  it('treats a WI with no recorded cost as zero rather than throwing', () => {
    expect(() => assertWithinCostCap(makeState(), 20, 'revision-loop')).not.toThrow();
  });
});
