import type { StepSpend } from '../types/index.ts';
import { formatToolUsage } from './tool-usage-tracker.ts';

/**
 * Steps ordered by spend, descending, ties broken on name.
 *
 * Descending because the question these renderers exist to answer is "where did
 * the money go" — the answer belongs at the front, not in whatever order the
 * pipeline happened to touch the keys. The name tie-break keeps the ordering
 * stable across runs so two reports can be diffed.
 */
function bySpendDescending(
  perStage: Record<string, StepSpend> | undefined,
): [string, StepSpend][] {
  if (!perStage) return [];
  return Object.entries(perStage).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
}

/** Thousands-separated integer. Hand-rolled rather than `toLocaleString` so the output does not vary with the host locale. */
function group(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One-line per-step spend split for the watcher log, e.g.
 * `coder $8.21, reviewer $4.02 ×6, analyzer $0.13`. Empty string when nothing
 * was recorded, so callers can concatenate conditionally.
 *
 * `prefix:sub` steps collapse into one `prefix` entry annotated with how many
 * sub-steps it covers. The reviewer's six axes as six near-identical entries
 * would push this line past the width where a split is easier to read than the
 * total it replaces; the per-axis figures stay in the WI log and the ledger,
 * which is where someone drilling into a spike is already looking.
 */
export function formatSpendLine(perStage: Record<string, StepSpend> | undefined): string {
  const grouped = new Map<string, { usd: number; subSteps: number }>();
  for (const [step, s] of Object.entries(perStage ?? {})) {
    const key = step.split(':')[0]!;
    const g = grouped.get(key) ?? { usd: 0, subSteps: 0 };
    g.usd += s.usd;
    g.subSteps += 1;
    grouped.set(key, g);
  }
  if (grouped.size === 0) return '';

  return [...grouped.entries()]
    .sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]))
    .map(([step, g]) => `${step} $${g.usd.toFixed(2)}${g.subSteps > 1 ? ` ×${g.subSteps}` : ''}`)
    .join(', ');
}

export interface CostReportInput {
  workItemId: number;
  /** completed | failed | rejected | paused. */
  outcome: string;
  /** ISO timestamp of when the run reached this outcome. */
  at: string;
  totalUsd: number;
  perStage: Record<string, StepSpend>;
  toolUsage: Record<string, number>;
  prId?: number;
  prUrl?: string;
}

/**
 * The spend block appended to a work item's log file when a run ends.
 *
 * Markdown table inside a plain log file: it stays readable in a terminal, and
 * pastes into a WI comment or a PR without reformatting. `totalUsd` is rendered
 * as given rather than re-summed from `perStage` — the two can legitimately
 * disagree when a stage errored before it could attribute its spend, and
 * silently papering over that gap would hide exactly the run worth inspecting.
 */
export function renderCostReport(input: CostReportInput): string {
  const pr = input.prId !== undefined ? ` · PR !${input.prId}${input.prUrl ? ` ${input.prUrl}` : ''}` : '';
  const lines: string[] = [
    '',
    `=== outcome: ${input.outcome} · cost $${input.totalUsd.toFixed(4)} · ${input.at}${pr} ===`,
    '',
  ];

  const entries = bySpendDescending(input.perStage);
  if (entries.length === 0) {
    lines.push('(no per-step spend recorded)');
  } else {
    lines.push('| step | usd | calls | model | in / out | turns |');
    lines.push('|---|---|---|---|---|---|');
    let calls = 0;
    for (const [step, s] of entries) {
      calls += s.calls;
      lines.push(
        `| ${step} | $${s.usd.toFixed(4)} | ${s.calls} | ${s.models.join(', ')} | ${group(s.inputTokens)} / ${group(s.outputTokens)} | ${s.turns} |`,
      );
    }
    lines.push(`| **Total** | **$${input.totalUsd.toFixed(4)}** | **${calls}** | | | |`);
  }

  // formatToolUsage yields a ', tools: ...' log-line suffix; re-label it for a
  // standalone line rather than duplicating the sort-and-join logic here.
  const tools = formatToolUsage(input.toolUsage);
  if (tools) {
    lines.push('');
    lines.push(`Tools: ${tools.replace(/^, tools: /, '')}`);
  }

  lines.push('');
  return lines.join('\n');
}
