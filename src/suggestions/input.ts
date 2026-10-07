import { z } from 'zod';
import type { Finding } from '../types/index.ts';
import { capPrDescription } from '../pipeline/stages/draft-pr-creator.ts';

/**
 * mutant-fixer's handover file. The contract lives in mutant-fixer's
 * docs/handover/devopscoder-apply-suggestions.md; change both together.
 */
const suggestionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'id must be letters, digits, - or _'),
  file: z
    .string()
    .min(1)
    .refine((f) => !f.includes('\\'), 'file must use forward slashes')
    .refine((f) => !f.startsWith('/') && !/^[A-Za-z]:/.test(f), 'file must be relative to the repo root')
    .refine((f) => !f.split('/').includes('..'), 'file must stay inside the repo'),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string(),
  code: z.string().min(1),
  confidence: z.string(),
});

const inputSchema = z
  .object({
    mode: z.enum(['pr', 'push']),
    repository: z.string().min(1),
    pullRequestId: z.number().int().positive(),
    parentPullRequestUrl: z.string().url(),
    reviewerId: z.string().min(1),
    sourceRefName: z.string().startsWith('refs/heads/'),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/, 'headCommit must be a full 40-char sha'),
    runNo: z.number().int().nonnegative(),
    suggestions: z.array(suggestionSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const s of v.suggestions) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['suggestions'], message: `duplicate id ${s.id}` });
      seen.add(s.id);
    }
  });

export type SuggestionInput = z.infer<typeof inputSchema>;
export type Suggestion = SuggestionInput['suggestions'][number];
export type SuggestionMode = SuggestionInput['mode'];

export function parseSuggestionInput(
  text: string,
): { ok: true; input: SuggestionInput } | { ok: false; error: string } {
  let raw: unknown;
  try {
    // A UTF-8 BOM is not JSON; strip it.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, error: `invalid-input: not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const result = inputSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `invalid-input: ${issues}` };
  }
  return { ok: true, input: result.data };
}

/**
 * 'critical' so the fix-findings prompt lists it first. The severity has no
 * other meaning here: every suggestion is a verified fix to apply.
 */
export function suggestionToFinding(s: Suggestion): Finding {
  return {
    severity: 'critical',
    file: s.file,
    ...(s.line !== undefined ? { line: s.line } : {}),
    title: s.title,
    description: s.description,
    suggestion: s.code,
    axis: 'mutation',
  };
}

export function sha7(sha: string): string {
  return sha.slice(0, 7);
}

export function mutantBranchName(pullRequestId: number, headCommit: string): string {
  return `mutant/pr-${pullRequestId}-${sha7(headCommit)}`;
}

/** mutant-fixer ends each description with "Kills mutants: 140, 141". */
function killedMutants(description: string): string | undefined {
  const m = /Kills mutants:\s*([0-9][0-9 ,]*)/i.exec(description);
  return m?.[1]?.trim().replace(/,$/, '');
}

export function commitMessage(input: SuggestionInput, s: Suggestion): string {
  const ids = killedMutants(s.description);
  return ids
    ? `test: ${s.id} kill mutants ${ids} (mutant-fixer run ${input.runNo})`
    : `test: ${s.id} (mutant-fixer run ${input.runNo})`;
}

export function stackedPrTitle(input: SuggestionInput): string {
  return `Mutation fixes for !${input.pullRequestId} (run ${input.runNo})`;
}

export function buildStackedPrDescription(input: SuggestionInput, appliedIds: string[]): string {
  const applied = new Set(appliedIds);
  const bullets = input.suggestions
    .filter((s) => applied.has(s.id))
    .map((s) => `- **${s.id}** ${s.title}: ${(s.description.split('\n')[0] ?? '').trim()}`);
  return capPrDescription(
    [
      `Mutation-test fixes for [!${input.pullRequestId}](${input.parentPullRequestUrl}), from mutant-fixer run ${input.runNo}.`,
      'Each commit adds one fix that was verified on a BC environment: it compiles, passes on the PR code and kills the listed mutants.',
      '',
      ...bullets,
    ].join('\n'),
  );
}
