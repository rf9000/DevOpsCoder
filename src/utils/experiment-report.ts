import type { BaseCheckResult, RunResult } from '../services/experiment-runner.ts';

export interface VariantStats {
  variant: string;
  /** Runs that count: rate-limited, env-failed and cancelled runs say nothing about the variant. */
  scored: number;
  completed: number;
  /** Final build-and-test gate ran, compiled, and every test passed. */
  passed: number;
  /** Runs where the final gate actually judged the code (ran, not skipped). */
  gateJudged: number;
  minTokens: number;
  maxTokens: number;
  /** The gate could not judge the code (environment fault, nothing to test). */
  gateSkipped: number;
  meanUsd: number;
  meanTokens: number;
  meanReviewerRounds: number;
  meanFixAttempts: number;
  /** Referee blocking + critical per refereed run; undefined when no run was refereed. */
  meanRefereeSevere?: number;
  meanRefereeMajor?: number;
  meanWallMin: number;
  /** Mean est. USD per step, reviewer axes collapsed into `reviewer`. */
  perStepUsd: Record<string, number>;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function isScored(r: RunResult): boolean {
  return r.outcome !== 'rate-limited' && r.outcome !== 'cancelled' && r.outcome !== 'env-failed';
}

export function gatePassed(r: RunResult): boolean {
  const v = r.verification;
  return v !== undefined && v.finalGate && !v.skipped && v.compiled && v.passed;
}

export function summarizeVariant(variant: string, all: RunResult[]): VariantStats {
  const runs = all.filter((r) => r.variant === variant && isScored(r));
  const refereed = runs.filter((r) => r.referee !== undefined);
  const perStep: Record<string, number[]> = {};
  for (const r of runs) {
    const collapsed: Record<string, number> = {};
    for (const [key, s] of Object.entries(r.perStage)) {
      const k = key.split(':')[0]!;
      collapsed[k] = (collapsed[k] ?? 0) + s.usd;
    }
    for (const [k, usd] of Object.entries(collapsed)) (perStep[k] ??= []).push(usd);
  }
  // Divide by every scored run, not just the runs that reached the step: a
  // variant that dies before test-author did not spend "nothing per run" on it.
  const perStepUsd: Record<string, number> = {};
  for (const [k, xs] of Object.entries(perStep)) perStepUsd[k] = xs.reduce((a, b) => a + b, 0) / runs.length;

  return {
    variant,
    scored: runs.length,
    completed: runs.filter((r) => r.outcome === 'completed').length,
    passed: runs.filter(gatePassed).length,
    gateJudged: runs.filter((r) => r.verification?.finalGate === true && !r.verification.skipped).length,
    minTokens: runs.length ? Math.min(...runs.map((r) => r.totalTokens)) : 0,
    maxTokens: runs.length ? Math.max(...runs.map((r) => r.totalTokens)) : 0,
    gateSkipped: runs.filter((r) => r.verification?.skipped === true).length,
    meanUsd: mean(runs.map((r) => r.costUsd)),
    meanTokens: mean(runs.map((r) => r.totalTokens)),
    meanReviewerRounds: mean(runs.map((r) => r.reviewer?.rounds ?? 0)),
    meanFixAttempts: mean(runs.map((r) => r.verification?.attempts ?? 0)),
    ...(refereed.length > 0
      ? {
          meanRefereeSevere: mean(refereed.map((r) => r.referee!.findings.blocking + r.referee!.findings.critical)),
          meanRefereeMajor: mean(refereed.map((r) => r.referee!.findings.major)),
        }
      : {}),
    meanWallMin: mean(runs.map((r) => r.wallMs / 60_000)),
    perStepUsd,
  };
}

/** Runs per variant below which one run's noise reads as a result. */
export const MIN_RUNS_FOR_VERDICT = 2;

/**
 * Why no verdict can be given, or undefined when one can. The first smoke run
 * flagged a variant whose knob saved nothing as a win: one run each, and
 * run-to-run variance in unrelated steps was 2x. With SKIP_BUILD_TEST both
 * sides also had zero gate results, which read as "pass rate no worse".
 */
export function verdictBlocker(v: VariantStats, base: VariantStats): string | undefined {
  if (v.scored < MIN_RUNS_FOR_VERDICT || base.scored < MIN_RUNS_FOR_VERDICT) {
    return `insufficient runs (need ≥${MIN_RUNS_FOR_VERDICT} each)`;
  }
  if (v.gateJudged === 0 || base.gateJudged === 0) return 'no gate result';
  return undefined;
}

/**
 * "Cheaper with no quality loss" against baseline. Ranked on tokens, not
 * dollars: on a subscription the dollar figure is an API-price estimate,
 * while tokens are what the usage limit actually counts.
 */
export function isWin(v: VariantStats, base: VariantStats): boolean {
  if (v.variant === base.variant || verdictBlocker(v, base) !== undefined) return false;
  const passRate = v.passed / v.gateJudged;
  const basePassRate = base.passed / base.gateJudged;
  const severeOk =
    v.meanRefereeSevere === undefined ||
    base.meanRefereeSevere === undefined ||
    v.meanRefereeSevere <= base.meanRefereeSevere;
  return v.meanTokens < base.meanTokens && passRate >= basePassRate && severeOk;
}

const pct = (v: number, base: number): string =>
  base === 0 ? '—' : `${v >= base ? '+' : ''}${(((v - base) / base) * 100).toFixed(0)}%`;
const fmtTok = (n: number): string => `${(n / 1_000_000).toFixed(2)}M`;
const opt = (n: number | undefined, d = 1): string => (n === undefined ? '—' : n.toFixed(d));

export function renderExperimentReport(args: {
  runId: string;
  results: RunResult[];
  variants: string[];
  overheadUsd: number;
  skippedForBudget: number;
  baseChecks?: BaseCheckResult[];
}): string {
  const stats = args.variants.map((v) => summarizeVariant(v, args.results));
  const base = stats.find((s) => s.variant === 'baseline');
  const lines: string[] = [
    `# Experiment ${args.runId}`,
    '',
    '"est. $" is the SDK\'s API-price estimate. On a subscription it is not a bill. Tokens (input + output + cache write + cache read) are what count against the usage limit, so variants are ranked on tokens.',
    '',
    `Overhead (shared analyzer + referee reviews), not billed to any variant: est. $${args.overheadUsd.toFixed(2)}.`,
    ...(args.skippedForBudget > 0 ? [`**${args.skippedForBudget} run(s) not started: budget reached.**`] : []),
    ...(args.results.some((r) => !isScored(r))
      ? [`${args.results.filter((r) => !isScored(r)).length} run(s) rate-limited, without an environment, or cancelled: not scored. Rerun the same command to resume them.`]
      : []),
    '',
    '## Variants',
    '',
    '| variant | runs | completed | gate pass | gate skipped | tokens | min–max | Δ tokens | est. $ | Δ $ | review rounds | fix attempts | referee blk+crit | referee major | wall min | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of stats) {
    const blocker = base && s.variant !== 'baseline' ? verdictBlocker(s, base) : undefined;
    const verdict =
      s.variant === 'baseline'
        ? 'baseline'
        : blocker
          ? `no verdict: ${blocker}`
          : base && isWin(s, base)
            ? '**cheaper, no quality loss**'
            : '';
    lines.push(
      `| ${s.variant} | ${s.scored} | ${s.completed} | ${s.passed}/${s.gateJudged} | ${s.gateSkipped} | ${fmtTok(s.meanTokens)} | ${fmtTok(s.minTokens)}–${fmtTok(s.maxTokens)} | ${base ? pct(s.meanTokens, base.meanTokens) : '—'} | $${s.meanUsd.toFixed(2)} | ${base ? pct(s.meanUsd, base.meanUsd) : '—'} | ${s.meanReviewerRounds.toFixed(1)} | ${s.meanFixAttempts.toFixed(1)} | ${opt(s.meanRefereeSevere)} | ${opt(s.meanRefereeMajor)} | ${s.meanWallMin.toFixed(0)} | ${verdict} |`,
    );
  }

  if (args.baseChecks && args.baseChecks.length > 0) {
    lines.push('', '## Base check', '', 'Each base commit is deployed and tested once, with no LLM calls, before any variant runs. A base that does not compile is skipped: every variant would pay to repair it.', '', '| WI | base | already-red codeunits | note |', '|---|---|---|---|');
    for (const c of args.baseChecks) {
      const red = c.redCodeunits.map((r) => `${r.name ?? r.id} (${r.failed})`).join(', ') || '—';
      lines.push(`| ${c.wiId} | ${c.status} | ${red} | ${(c.reason ?? '').replace(/\|/g, '/')} |`);
    }
  }

  const steps = [...new Set(stats.flatMap((s) => Object.keys(s.perStepUsd)))].sort();
  lines.push('', '## Mean est. $ per step', '', `| step | ${stats.map((s) => s.variant).join(' | ')} |`, `|---|${stats.map(() => '---').join('|')}|`);
  for (const step of steps) {
    lines.push(`| ${step} | ${stats.map((s) => `$${(s.perStepUsd[step] ?? 0).toFixed(2)}`).join(' | ')} |`);
  }

  lines.push('', '## Per run', '', '| WI | variant | rep | outcome | gate | tokens | est. $ | rounds | referee blk/crit/maj | diff | note |', '|---|---|---|---|---|---|---|---|---|---|---|');
  const sorted = [...args.results].sort((a, b) => a.wiId - b.wiId || a.variant.localeCompare(b.variant) || a.rep - b.rep);
  for (const r of sorted) {
    const v = r.verification;
    const gate = !v ? '—' : v.skipped ? 'skipped' : gatePassed(r) ? 'pass' : v.compiled ? 'tests red' : 'compile red';
    const ref = r.referee ? `${r.referee.findings.blocking}/${r.referee.findings.critical}/${r.referee.findings.major}` : '—';
    const note = r.error ? `${r.error.stage}: ${r.error.message.slice(0, 80).replace(/\|/g, '/')}` : '';
    lines.push(
      `| ${r.wiId} | ${r.variant} | ${r.rep} | ${r.outcome} | ${gate} | ${fmtTok(r.totalTokens)} | $${r.costUsd.toFixed(2)} | ${r.reviewer?.rounds ?? '—'} | ${ref} | +${r.diff.insertions}/-${r.diff.deletions} in ${r.diff.files} | ${note} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
