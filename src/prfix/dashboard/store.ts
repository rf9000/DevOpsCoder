import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrFixOutcome, PrFixReview } from '../types.ts';

export interface QueueEntry {
  prId: number;
  queuedBy: string;
  queuedAt: string;
  /** The PR's title from the catalog at queue time; used for the history line. */
  title?: string;
}

export interface PendingApproval {
  prId: number;
  title: string;
  triggeredBy: string;
  readyAt: string;
  expiresAt: string;
  review: PrFixReview;
}

export interface ActiveJob {
  prId: number;
  startedAt: string;
  triggeredBy: string;
  title: string;
}

export interface HistoryLine {
  at: string;
  prId: number;
  title: string;
  triggeredBy: string;
  durationMs: number | null;
  outcome: PrFixOutcome;
  approvedBy?: string;
  rejectedBy?: string;
}

const HISTORY_LIMIT = 500;

/**
 * The dashboard fix-pr worker's persisted state under `<stateDir>/prfix`.
 * Every rewrite goes to a temp file first and is renamed into place, so a crash
 * mid-write leaves the previous file whole. The one exception is a history
 * append below the cap, which is a plain one-line append (a rename per job
 * would rewrite the whole file each time); a torn last line from a crash is
 * skipped on read, and the next append then rewrites the file whole.
 */
export class PrFixJobStore {
  private historyCache: string[] | null = null;
  /** The file on disk holds a torn line or lacks a final newline; see `historyLines`. */
  private historyDirty = false;

  constructor(private readonly dir: string) {}

  queue(): QueueEntry[] {
    return this.readJson<QueueEntry[]>('queue.json') ?? [];
  }

  setQueue(queue: QueueEntry[]): void {
    this.writeJson('queue.json', queue);
  }

  pending(): PendingApproval[] {
    return this.readJson<PendingApproval[]>('pending.json') ?? [];
  }

  setPending(pending: PendingApproval[]): void {
    this.writeJson('pending.json', pending);
  }

  active(): ActiveJob | null {
    return this.readJson<ActiveJob>('active.json');
  }

  /** `null` clears the marker (writes `null`, read back as no active job). */
  setActive(job: ActiveJob | null): void {
    this.writeJson('active.json', job);
  }

  appendHistory(line: HistoryLine): void {
    const lines = [...this.historyLines(), JSON.stringify(line)];
    if (lines.length <= HISTORY_LIMIT && !this.historyDirty) {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, 'history.jsonl'), `${lines[lines.length - 1]}\n`, 'utf8');
      this.historyCache = lines;
      return;
    }
    const kept = lines.slice(-HISTORY_LIMIT);
    this.writeText('history.jsonl', `${kept.join('\n')}\n`);
    this.historyCache = kept;
    this.historyDirty = false;
  }

  /** Newest first. */
  history(): HistoryLine[] {
    return this.historyLines()
      .map((l) => JSON.parse(l) as HistoryLine)
      .reverse();
  }

  /**
   * Read from disk once per instance, then kept in step with every append (the
   * worker is the file's only writer). A torn last line left by a crash
   * mid-append is dropped here and marks the file dirty: a plain append would
   * land on the end of the fragment and be lost with it, so the next append
   * rewrites the file whole instead.
   */
  private historyLines(): string[] {
    if (this.historyCache) return this.historyCache;
    const path = join(this.dir, 'history.jsonl');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    let dropped = false;
    this.historyCache = raw.split('\n').filter((l) => {
      if (l.trim() === '') return false;
      try {
        JSON.parse(l);
        return true;
      } catch {
        dropped = true;
        return false;
      }
    });
    this.historyDirty = dropped || (raw !== '' && !raw.endsWith('\n'));
    return this.historyCache;
  }

  private readJson<T>(name: string): T | null {
    const path = join(this.dir, name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T | null;
  }

  private writeJson(name: string, value: unknown): void {
    this.writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  private writeText(name: string, text: string): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, name);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, path);
  }
}

/**
 * On Windows a rename over a file that a scanner or indexer briefly holds open
 * fails EPERM/EBUSY; it succeeds a moment later. Linux (the container) never
 * takes the retry path.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      Bun.sleepSync(10);
    }
  }
}
