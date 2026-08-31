import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Logger } from '../utils/logger.ts';

/** One line of the ledger. Serialised as JSON, one record per line (JSONL). */
export interface CostRecord {
  /** ISO timestamp of when the run finished. */
  at: string;
  workItemId: number;
  /** completed | failed | rejected | paused — what the pipeline did with it. */
  outcome: string;
  /** Cumulative USD spent across every LLM stage of this run. */
  costUsd: number;
  /** Draft PR id, when one was opened. */
  prId?: number;
  prUrl?: string;
  /** Per-stage USD breakdown, so a spend spike can be attributed. */
  perStage?: Record<string, number>;
}

export interface CostLedger {
  record(entry: CostRecord): void;
}

/**
 * Append-only spend log, one JSON object per line.
 *
 * JSONL rather than CSV or a rolling summary: it survives concurrent appends
 * (each record is a single short write), it is greppable by eye, and
 * `jq -s 'map(.costUsd) | add'` totals it without a parser.
 *
 * Every write is best-effort. A ledger failure must never turn a completed run
 * into a failed one — the pipeline's job is the PR, not the bookkeeping.
 */
export function createCostLedger(deps: { path: string; logger: Logger }): CostLedger {
  let warned = false;

  return {
    record(entry: CostRecord): void {
      try {
        mkdirSync(dirname(deps.path), { recursive: true });
        appendFileSync(deps.path, `${JSON.stringify(entry)}\n`, 'utf-8');
      } catch (err) {
        // Warn once per process: a broken path would otherwise log on every WI.
        if (!warned) {
          warned = true;
          deps.logger.warn(
            `cost ledger: could not append to ${deps.path} :: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  };
}
