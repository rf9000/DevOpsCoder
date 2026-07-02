import { describe, it, expect } from 'bun:test';
import { createToolUsageTracker, mergeToolUsage, formatToolUsage } from '../../src/utils/tool-usage-tracker.ts';
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

describe('createToolUsageTracker', () => {
  it('fresh state initializes then accumulates on add', () => {
    const state = makeState();
    const tracker = createToolUsageTracker(state);
    expect(state.outputs.toolUsage).toEqual({});
    tracker.add('coder', { Edit: 1 });
    expect(state.outputs.toolUsage).toEqual({ Edit: 1 });
  });

  it('two add calls with overlapping tool names accumulate', () => {
    const state = makeState();
    const tracker = createToolUsageTracker(state);
    tracker.add('coder', { Edit: 2 });
    tracker.add('reviewer', { Edit: 1, Bash: 1 });
    expect(tracker.total()).toEqual({ Edit: 3, Bash: 1 });
  });

  it('resume case preserves pre-existing counts and continues accumulating', () => {
    const state = makeState();
    state.outputs.toolUsage = { Edit: 5 };
    const tracker = createToolUsageTracker(state);
    expect(tracker.total()).toEqual({ Edit: 5 });
    tracker.add('coder', { Edit: 1 });
    expect(tracker.total()).toEqual({ Edit: 6 });
  });
});

describe('mergeToolUsage', () => {
  it('sums multiple tool-usage maps together', () => {
    expect(mergeToolUsage([{ Edit: 2, Bash: 1 }, { Edit: 1, Write: 3 }])).toEqual({
      Edit: 3,
      Bash: 1,
      Write: 3,
    });
  });
});

describe('formatToolUsage', () => {
  it('formats empty as empty string, non-empty sorted by count desc then alpha', () => {
    expect(formatToolUsage({})).toBe('');
    expect(formatToolUsage({ Edit: 5, Bash: 2 })).toBe(', tools: Edit×5, Bash×2');
    expect(formatToolUsage({ Bash: 2, Edit: 2 })).toBe(', tools: Bash×2, Edit×2');
  });
});
