import { describe, it, expect } from 'bun:test';
import { triggeredByFrom, lookupTriggeredBy } from '../../src/utils/triggered-by.ts';
import type { WorkItemUpdate } from '../../src/types/index.ts';

function rev(by: string, oldValue: string | undefined, newValue: string): WorkItemUpdate {
  const change: { oldValue?: unknown; newValue?: unknown } = { newValue };
  if (oldValue !== undefined) change.oldValue = oldValue;
  return { revisedBy: { uniqueName: by }, fields: { 'System.Tags': change } };
}

describe('triggeredByFrom', () => {
  it('returns the lowercased adder of the most recent re-add', () => {
    const updates = [
      rev('Ann@X.com', undefined, 'agent'),
      rev('ann@x.com', 'agent', ''),
      rev('bob@x.com', undefined, 'agent'),
    ];
    expect(triggeredByFrom(updates, ['agent'])).toBe('bob@x.com');
  });

  it('lowercases the identity', () => {
    expect(triggeredByFrom([rev('Ann@X.com', undefined, 'agent')], ['agent'])).toBe('ann@x.com');
  });

  it('returns unknown when the tag was never added', () => {
    expect(triggeredByFrom([rev('ann@x.com', 'agent', 'agent; bug')], ['agent'])).toBe('unknown');
  });

  it('matches a second tag of the list', () => {
    const updates = [rev('cy@x.com', undefined, 'other')];
    expect(triggeredByFrom(updates, ['agent', 'other'])).toBe('cy@x.com');
  });
});

describe('lookupTriggeredBy', () => {
  it('returns the adder on success', async () => {
    const by = await lookupTriggeredBy(async () => [rev('Ann@X.com', undefined, 'agent')], ['agent'], () => {});
    expect(by).toBe('ann@x.com');
  });

  it('returns unknown and warns once when the fetch rejects', async () => {
    const warns: string[] = [];
    const by = await lookupTriggeredBy(async () => { throw new Error('boom'); }, ['agent'], (m) => warns.push(m));
    expect(by).toBe('unknown');
    expect(warns).toHaveLength(1);
  });
});
