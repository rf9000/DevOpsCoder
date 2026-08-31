import { describe, it, expect } from 'bun:test';
import { findTagAdder, formatAdoMention } from '../../src/utils/tag-history.ts';
import type { WorkItemUpdate } from '../../src/types/index.ts';

const alice = { id: 'guid-alice', displayName: 'Alice Smith', uniqueName: 'alice@x.com' };
const bob = { id: 'guid-bob', displayName: 'Bob Jones', uniqueName: 'bob@x.com' };

function tagUpdate(
  revisedBy: typeof alice,
  oldValue: string | undefined,
  newValue: string,
  revisedDate?: string,
): WorkItemUpdate {
  const change: { oldValue?: unknown; newValue?: unknown } = { newValue };
  if (oldValue !== undefined) change.oldValue = oldValue;
  return revisedDate !== undefined
    ? { revisedBy, revisedDate, fields: { 'System.Tags': change } }
    : { revisedBy, fields: { 'System.Tags': change } };
}

describe('findTagAdder', () => {
  it('finds the identity that added the tag', () => {
    const updates = [tagUpdate(alice, 'bug', 'bug; agent-implement', '2026-08-31T10:00:00Z')];
    const found = findTagAdder(updates, 'agent-implement');
    expect(found?.identity.displayName).toBe('Alice Smith');
    expect(found?.at).toBe('2026-08-31T10:00:00Z');
  });

  it('returns the MOST RECENT adder when a WI is tagged, rejected, and re-tagged', () => {
    const updates = [
      tagUpdate(alice, '', 'agent-implement', '2026-08-01T10:00:00Z'),
      tagUpdate(alice, 'agent-implement', 'need-input', '2026-08-02T10:00:00Z'),
      tagUpdate(bob, 'need-input', 'agent-implement', '2026-08-03T10:00:00Z'),
    ];
    // The person to notify is whoever asked for the current attempt.
    expect(findTagAdder(updates, 'agent-implement')?.identity.displayName).toBe('Bob Jones');
  });

  it('ignores revisions where the tag was already present', () => {
    const updates = [
      tagUpdate(alice, 'agent-implement', 'agent-implement; urgent', '2026-08-02T10:00:00Z'),
    ];
    expect(findTagAdder(updates, 'agent-implement')).toBeUndefined();
  });

  it('matches case-insensitively and tolerates whitespace around separators', () => {
    const updates = [tagUpdate(alice, 'bug', 'bug ;  Agent-Implement ')];
    expect(findTagAdder(updates, 'agent-implement')?.identity.id).toBe('guid-alice');
  });

  it('returns undefined for empty history or a tag never added', () => {
    expect(findTagAdder([], 'agent-implement')).toBeUndefined();
    expect(findTagAdder([tagUpdate(alice, '', 'bug')], 'agent-implement')).toBeUndefined();
  });

  it('ignores revisions that did not touch System.Tags', () => {
    const updates: WorkItemUpdate[] = [
      { revisedBy: alice, fields: { 'System.State': { oldValue: 'New', newValue: 'Active' } } },
    ];
    expect(findTagAdder(updates, 'agent-implement')).toBeUndefined();
  });

  it('falls back to System.ChangedDate when revisedDate is the open-ended 9999 sentinel', () => {
    const updates: WorkItemUpdate[] = [
      {
        revisedBy: alice,
        revisedDate: '9999-01-01T00:00:00Z',
        fields: {
          'System.Tags': { oldValue: '', newValue: 'agent-implement' },
          'System.ChangedDate': { newValue: '2026-08-31T12:00:00Z' },
        },
      },
    ];
    expect(findTagAdder(updates, 'agent-implement')?.at).toBe('2026-08-31T12:00:00Z');
  });
});

describe('formatAdoMention', () => {
  it('renders the data-vss-mention anchor ADO resolves', () => {
    expect(formatAdoMention(alice)).toBe(
      '<a href="#" data-vss-mention="version:2.0,guid-alice">@Alice Smith</a>',
    );
  });

  it('falls back to plain text when there is no identity GUID to resolve', () => {
    expect(formatAdoMention({ displayName: 'Alice Smith' })).toBe('@Alice Smith');
  });

  it('escapes HTML in the display name', () => {
    const out = formatAdoMention({ id: 'g', displayName: 'A <b>&' });
    expect(out).toContain('A &lt;b&gt;&amp;');
    expect(out).not.toContain('<b>');
  });

  it('returns empty string when the identity has no usable name', () => {
    expect(formatAdoMention({ id: 'g' })).toBe('');
  });
});
