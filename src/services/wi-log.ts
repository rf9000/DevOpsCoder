import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger, type Logger } from '../utils/logger.ts';

export interface WiLog {
  /** Logger that writes to the console exactly as before, and tees to the WI's file. */
  logger: Logger;
  /** Append a raw block verbatim — no timestamp prefix. Used for the end-of-run cost table. */
  append(block: string): void;
}

export interface WiLogFactory {
  /** Open (creating or appending to) the log file for one work item. */
  open(workItemId: number): WiLog;
}

export interface WiLogFactoryDeps {
  /** Directory the per-WI files live in. Created on demand. */
  dir: string;
  /** Base logger, used only to warn that the log directory is unwritable. */
  logger: Logger;
  /** Mirrors the base logger's prefix so file and console lines match. */
  prefix?: string;
  /** Injectable clock for the run separator. */
  now?: () => Date;
}

/**
 * Per-work-item log files: `<dir>/WI<id>.log`.
 *
 * The container log interleaves every WI the watcher touches, and a resumed WI
 * spreads its spend across cycles that may be hours apart — so reading a total
 * back to its cause means scrolling through unrelated work, if the lines are
 * even still in the ring buffer. One file per WI keeps the whole story of a
 * work item, across every cycle, in one place.
 *
 * Every write is best-effort, for the same reason the cost ledger's are: a log
 * that cannot be written must not turn a completed run into a failed one.
 */
export function createWiLogFactory(deps: WiLogFactoryDeps): WiLogFactory {
  const now = deps.now ?? (() => new Date());
  // Warn once per factory: an unwritable directory would otherwise produce a
  // warning for every line of every WI, drowning the console it warns on.
  let warned = false;

  function warnOnce(err: unknown): void {
    if (warned) return;
    warned = true;
    deps.logger.warn(
      `WI log: could not write under ${deps.dir} :: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    open(workItemId: number): WiLog {
      const path = join(deps.dir, `WI${workItemId}.log`);

      const write = (text: string): void => {
        try {
          mkdirSync(deps.dir, { recursive: true });
          appendFileSync(path, text, 'utf-8');
        } catch (err) {
          warnOnce(err);
        }
      };

      // Append rather than truncate, and mark where this cycle begins: a
      // resumed WI banks most of its spend in an earlier cycle, and losing
      // those lines loses the explanation for the running total.
      write(`\n=== run ${now().toISOString()} ===\n`);

      return {
        logger: createLogger(deps.prefix, [(line) => write(`${line}\n`)]),
        append: (block) => write(block),
      };
    },
  };
}
