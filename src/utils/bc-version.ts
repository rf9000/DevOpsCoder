/**
 * BC versions are dotted numbers ("29.0.0.0"). String comparison is wrong here
 * — "9.0.0.0" sorts ABOVE "29.0.0.0" lexically — so every comparison in this
 * module is numeric, segment by segment.
 *
 * Unparseable input is never an exception: callers are comparing versions that
 * came from a third-party CLI and from hand-written app.json files, and a
 * comparison that cannot be made must degrade to "do not block", never to a
 * thrown error deep inside a pipeline stage.
 */

const SEGMENTS = 4;

/** `[major, minor, build, revision]`, short forms zero-padded; `undefined` if not a version. */
export function parseBcVersion(raw: string): number[] | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  const parts = trimmed.split('.');
  if (parts.length > SEGMENTS) return undefined;

  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  while (nums.length < SEGMENTS) nums.push(0);
  return nums;
}

/** Standard comparator contract: negative if a < b, 0 if equal, positive if a > b. */
export function compareBcVersions(a: number[], b: number[]): number {
  for (let i = 0; i < SEGMENTS; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Highest of `versions`, returned in its original spelling. Unparseable entries
 * are skipped. Numerically equal spellings are first-seen-wins: given
 * `['29.0', '29.0.0.0']` the result is `'29.0'`, since neither compares greater.
 */
export function maxBcVersion(versions: string[]): string | undefined {
  let best: { raw: string; parsed: number[] } | undefined;
  for (const raw of versions) {
    const parsed = parseBcVersion(raw);
    if (!parsed) continue;
    if (!best || compareBcVersions(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw;
}

/**
 * The lowest entry of `available` that is >= `required` — an exact match when
 * one exists, the next one up otherwise.
 *
 * Tracks what app.json asks for rather than what DemoPortal published most
 * recently: BC 30 appearing in the catalogue must not silently retarget every
 * work item onto a platform the team has not adopted.
 */
export function selectBcVersion(required: string, available: string[]): string | undefined {
  const req = parseBcVersion(required);
  if (!req) return undefined;

  let best: { raw: string; parsed: number[] } | undefined;
  for (const raw of available) {
    const parsed = parseBcVersion(raw);
    if (!parsed) continue;
    if (compareBcVersions(parsed, req) < 0) continue;
    if (!best || compareBcVersions(parsed, best.parsed) < 0) best = { raw, parsed };
  }
  return best?.raw;
}

/** Whether `actual` is at least `required`. Unparseable on either side => true (see module note). */
export function satisfiesBcVersion(required: string, actual: string): boolean {
  const req = parseBcVersion(required);
  const act = parseBcVersion(actual);
  if (!req || !act) return true;
  return compareBcVersions(act, req) >= 0;
}
