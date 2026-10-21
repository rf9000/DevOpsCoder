import type { WorkItemUpdate } from '../types/index.ts';
import { findTagAdder } from './tag-history.ts';

export const AUTOMATIC = 'automatic';
export const UNKNOWN = 'unknown';

/** Lowercased uniqueName of the most recent revision that added any of `tags`; UNKNOWN when none. */
export function triggeredByFrom(updates: WorkItemUpdate[], tags: string[]): string {
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    if (!update) continue;
    for (const tag of tags) {
      const added = findTagAdder([update], tag);
      const name = added?.identity.uniqueName;
      if (added) return name ? name.toLowerCase() : UNKNOWN;
    }
  }
  return UNKNOWN;
}

/**
 * Never throws: fetch errors or a fetch slower than `timeoutMs` → warn once + UNKNOWN.
 * The timeout matters because the ADO client retries with sleeps, and a run must
 * never wait on a failed lookup.
 */
export async function lookupTriggeredBy(
  fetchUpdates: () => Promise<WorkItemUpdate[]>,
  tags: string[],
  warn: (msg: string) => void,
  timeoutMs = 10_000,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return triggeredByFrom(await Promise.race([fetchUpdates(), timeout]), tags);
  } catch (err) {
    warn(`triggeredBy lookup failed :: ${err instanceof Error ? err.message : String(err)}`);
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}
