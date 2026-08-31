import type { IdentityRef, WorkItemUpdate } from '../types/index.ts';

/** Split an ADO `System.Tags` string ("a; b; c") into trimmed, non-empty tags. */
function splitTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

export interface TagAddition {
  identity: IdentityRef;
  /** ISO timestamp of the revision that added the tag, when ADO reported one. */
  at?: string;
}

/**
 * Find who most recently added `tag`, by diffing `System.Tags` across the work
 * item's revision history.
 *
 * Scans newest-first and returns the first revision where the tag is present in
 * newValue but absent from oldValue. "Most recent" is deliberate: a work item
 * can be tagged, rejected, and re-tagged, and the person to notify is whoever
 * asked for the current attempt — not whoever asked first.
 *
 * Returns undefined when the history has no such revision (tag applied at
 * creation, history trimmed, or the caller could not fetch updates).
 */
export function findTagAdder(
  updates: WorkItemUpdate[],
  tag: string,
): TagAddition | undefined {
  const needle = tag.trim().toLowerCase();

  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    const change = update?.fields?.['System.Tags'];
    if (!change) continue;

    const before = splitTags(change.oldValue);
    const after = splitTags(change.newValue);
    if (!after.includes(needle) || before.includes(needle)) continue;

    const identity = update?.revisedBy;
    if (!identity) return undefined;

    // revisedDate is the reliable field, but ADO returns 9999-01-01 for the
    // open-ended latest revision; fall back to the changed-date field value.
    const revised = update.revisedDate;
    const changedDate = update.fields?.['System.ChangedDate']?.newValue;
    const at =
      revised && !revised.startsWith('9999')
        ? revised
        : typeof changedDate === 'string'
          ? changedDate
          : undefined;

    return at !== undefined ? { identity, at } : { identity };
  }

  return undefined;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render an ADO @-mention anchor. Azure DevOps resolves the mention from the
 * `data-vss-mention` attribute's identity GUID; the link text is only what a
 * human reads. Without a GUID there is nothing to resolve, so fall back to
 * plain "@Name" text rather than emitting a dead anchor.
 */
export function formatAdoMention(identity: IdentityRef): string {
  const name = identity.displayName ?? identity.uniqueName;
  if (!name) return '';
  if (!identity.id) return `@${name}`;
  return `<a href="#" data-vss-mention="version:2.0,${escapeHtmlAttr(identity.id)}">@${escapeHtmlAttr(name)}</a>`;
}

/**
 * Render an @-mention for a MARKDOWN surface (pull-request comment threads).
 *
 * Deliberately different from formatAdoMention: work-item comments are HTML and
 * take the `data-vss-mention` anchor, while PR comments are markdown and store
 * mentions as the bare `@<GUID>` token, which ADO expands to the person's name
 * on render and notifies them. Using the HTML anchor here shows raw markup.
 *
 * Returns '' without a GUID — there is nothing for ADO to resolve, and a
 * literal "@Name" in a PR comment notifies no one.
 */
export function formatAdoMentionMarkdown(identity: IdentityRef): string {
  if (!identity.id) return '';
  return `@<${identity.id}>`;
}
