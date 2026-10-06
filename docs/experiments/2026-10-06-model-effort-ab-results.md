# Model/effort A/B results — ab-3 and ab-4 (2026-10-03 to 2026-10-06)

## Question

Can we lower per-work-item spend by lowering reasoning effort or swapping in a
cheaper model for individual pipeline steps, without losing quality?

## Method

Offline replay with the `experiment` command (`src/services/experiment-runner.ts`):

- Each corpus WI is replayed from a pinned `baseSha` (the commit before the
  human fix), with comments after the fix stripped and ADO wrapped read-only.
- Full verification gate: a fresh BC environment per run, deploy, and the
  related test codeunits (`CONTINIA_MAX_TEST_CODEUNITS=8`).
- The analyzer runs once per WI and is shared by every variant.
- A referee review (six axes, always the baseline config) grades every
  finished diff, so a variant that cheapens the reviewer cannot grade itself.
- Runs use the operator's Claude Code subscription. Dollar figures are the
  SDK's estimate at API prices ("est. $"), not a bill.
- Each variant changes one knob. Two reps per WI × variant.

Corpus:

| WI | size | human fix |
|---|---|---|
| 83666 | small | PR 56993, 2 files, +127/-83 |
| 82782 | medium-small | PR 55882, 2 files, +141 |
| 82605 | large (auth + upgrade + telemetry) | PR 56803, 18 files, +3370/-128 |

Variants:

| name | change |
|---|---|
| baseline | production settings |
| coder-effort-medium | `CLAUDE_EFFORT_CODER=medium`, `CLAUDE_EFFORT_FIX_FINDINGS=medium` |
| fixer-effort-medium | `CLAUDE_EFFORT_TEST_FIXER=medium` |
| cheap-axes | naming-style, performance and code-structure reviewers on Haiku 4.5 |
| no-plan | no plan step for coder and test-author |
| plan-effort-low (ab-4) | `CLAUDE_EFFORT_PLANNING=low` |
| test-author-effort-medium (ab-4) | `CLAUDE_EFFORT_TEST_AUTHOR=medium` |

## Results

Mean est. $ per run. Every run below passed the gate unless marked.

| variant | 83666 | 82782 | 82605 |
|---|---|---|---|
| baseline | 3.89 | 2.67 | 13.0 (16.61, 9.35¹) |
| coder-effort-medium | 2.99 | 2.88 | 29.8 (31.05 ✗², 28.51; 3 review rounds each) |
| fixer-effort-medium | 3.84 | **2.17** | 19.95 (21.30, 18.60) |
| cheap-axes | 4.58 | 2.66 | 15.68 ✗ (environment stopped) |
| no-plan | 3.11 | 2.23 | not run |
| plan-effort-low | — | — | 19.50 (23.62, 15.38) |
| test-author-effort-medium | — | — | 25.44 (25.30 ✗³, 25.57) |

1. Undercounted: the run died mid-coder and was resumed; the lost spend was never persisted.
2. Failed at the final gate on a deploy failure, before `--unpublish-dependents` and the cascade fix below.
3. Failed on a classification bug (fixed in `a975ad0`), not on the variant.

Referee findings on 82605 (blocking/critical/major, summed over both reps):

| variant | findings |
|---|---|
| baseline | 1 / 0 / 5 |
| plan-effort-low | 0 / 1 / 5 |
| test-author-effort-medium | 0 / 0 / 0 |
| fixer-effort-medium | 0 / 1 / 2 |
| coder-effort-medium | 0 / 0 / 0 |

On the small and medium WIs the referee found nothing above minor for any variant.

## Findings

1. **No effort or model change is a clear saving.**
   - `fixer-effort-medium` is cheaper on 82782 (-19%), flat on 83666, and more expensive on 82605.
   - `coder-effort-medium` is cheaper on 83666 only. On 82605 it needed 3 review rounds per run and cost about twice the baseline.
   - `plan-effort-low` makes the plan step cheap (about $0.50 instead of $1–2), but the coder and test-author then work harder. Net +50% on 82605.
   - `test-author-effort-medium` does not make the test-author cheaper ($5.7–6.6, 92–117 turns, against $3.7–5.9 at baseline). Its runs took 2–3 review rounds, so net +96%. Its diffs were the cleanest by referee count, but two runs cannot show that this is real.
   - `cheap-axes` saves nothing: the three cheap axes were never the expensive ones.
   - `no-plan` was dropped: in the team's experience output without planning is consistently worse.

2. **Variance dominates on large items.** Baseline alone ranges from $9 to $17
   on 82605 (21M–46M tokens). Two reps cannot resolve effects smaller than
   that, and enough reps to do so would cost more than they could save.

3. **Review rounds drive cost more than effort does.** Each extra round on
   82605 adds roughly $3–5 (six reviewer axes plus fix-findings). The most
   expensive runs in every variant are the ones with 2–3 rounds.

4. **The pipeline's own review misses serious bugs on large items.** On 82605
   the referee found three blocking/critical issues in diffs the pipeline's
   reviewer had approved:
   - an HTTP 409 path that overwrites the stored password (ab-3, fixer-effort-medium);
   - `DeleteAuthenticationForBankSystem` wiping shared credential storage for other companies (ab-4, baseline);
   - a critical finding in ab-4 plan-effort-low rep 1.

   The pipeline reviewer and the referee use the same config. The difference
   is that the referee sees the final diff once, after tests exist, while the
   pipeline reviewer sees each round's diff.

5. **Infrastructure failures cost the most.** Each of these cost one full
   $15–30 run before it was fixed:
   - Deploy of a stale installed test app after a signature change (fixed: `--unpublish-dependents`).
   - Dependent sweep aborting on a published-but-not-installed dependent (fixed: `4ff1806`).
   - A compile failure's `unpublished-sibling` cascade classified as an environment problem, hiding the compile error from the fixer for the whole run (fixed: `a975ad0`).
   - A stopped environment timing out (fixed: `waitForRunning` starts it).
   - DemoPortal's 50-environment quota (fixed for experiments: the harness deletes its environments).

## Recommendations

1. **Keep production effort and model settings at the default.** Revisit
   `fixer-effort-medium` only if a larger corpus of small/medium WIs is run;
   the saving is at most about $0.50 per WI.
2. **Reduce review rounds.** This is the largest controllable cost. Candidates:
   tighten when a finding is `blocking`/`critical` (the severity ceilings
   already cap some axes), and give fix-findings a better chance of closing
   findings in one round.
3. **Strengthen the final review on large items.** Run one review of the full
   final diff after the test-author, at the same config as the referee, before
   the draft PR. Three serious bugs on one WI suggest this is worth its cost
   (about $3 per WI).
4. **Treat infrastructure reliability as the main cost lever.** Production
   still never deletes its environments; it needs a retention policy (for
   example, delete when the PR closes) before the 50-environment quota is hit
   again.

## Spend

| run | est. $ |
|---|---|
| ab-3 | 264.68 (222.91 runs + 41.77 analyzer/referee/base checks) |
| ab-4 | 114.29 (99.22 new runs + 15.07 referee; baseline-1 is copied from ab-3), plus about $10 lost to a killed run |

Raw results live under `experiments/runs/ab-3/` and `experiments/runs/ab-4/`
(gitignored); each has a `report.md`.
