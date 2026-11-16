import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentRunner } from '../pipeline/agent-stage.ts';
import type { Stage } from '../pipeline/stage.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { WorkItemContext } from '../services/wi-context.ts';
import { applyWorktreeOverlay } from '../services/worktree-overlay.ts';
import type { EnvironmentOutput, VerificationOutput, WorktreeContext } from '../types/index.ts';
import { assertWithinCostCap } from '../utils/cost-tracker.ts';
import { redactPat } from '../utils/git-auth.ts';
import {
  AL_OBJECT_TYPES,
  findCollisions,
  parseDeclaration,
  planRenumbers,
  type AlDeclaration,
  type CollisionGroup,
} from './al-objects.ts';
import type { PrFixConfig } from './config.ts';
import { renderSuccessComment } from './comment.ts';
import { NINJA_MAX_ASSIGN_ATTEMPTS, type NinjaClient } from './ninja.ts';
import type { PrFixGit, RebaseStep } from './prfix-git.ts';
import { resolveConflict } from './resolver.ts';
import {
  ConflictCapError,
  IdCollisionError,
  MergeCommitsError,
  PrUpToDateError,
  UnresolvedConflictError,
  type ConflictResolution,
  type PrFixInput,
  type RebaseOutput,
  type RenumberOutput,
} from './types.ts';

const REBASE_STAGE = 'rebase-onto-target';

function abortError(): Error {
  const err = new Error(`${REBASE_STAGE} aborted`);
  err.name = 'AbortError';
  return err;
}

/**
 * Rebase the PR branch onto its target, resolving each conflicting commit with
 * one capped resolver call.
 *
 * Every throw inside the loop — caps, cost cap, resolver failure, leftover
 * markers, abort, a failed `rebase --continue` — aborts the rebase first, so the
 * worktree is never left mid-rebase for the next stage (or a rerun) to trip on.
 * The abort is best-effort: if it fails too, that is logged and the original
 * error is what propagates.
 *
 * On success, `worktree.baseSha` becomes the target sha, so `build-and-test`'s
 * test selection diffs the PR's commits against the new base rather than the
 * PR's old head.
 */
export function createRebaseStage(deps: {
  git: PrFixGit;
  prfix: PrFixConfig;
  runner: AgentRunner;
  promptTemplate: string;
}): Stage {
  const { git, prfix } = deps;

  return {
    name: REBASE_STAGE,
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as (WorktreeContext & { targetSha: string }) | undefined;
      const input = state.outputs.prFixInput as PrFixInput | undefined;
      if (!worktree || !input) {
        throw new Error(`${REBASE_STAGE} requires state.outputs.worktree and .prFixInput`);
      }
      const { path, targetSha } = worktree;

      const preRebaseSha = await git.headSha(path);
      // `git rebase` linearizes merges away, so the pushed branch would no
      // longer be the PR's changes. Refused before anything starts.
      const merges = await git.countMergeCommits(path, targetSha);
      if (merges > 0) throw new MergeCommitsError(merges);

      const conflicts: ConflictResolution[] = [];
      let newHeadSha: string;

      try {
        // Inside the guard: startRebase can throw with a rebase in progress
        // (git stopped without conflicted files), and that must be aborted too.
        let step: RebaseStep = await git.startRebase(path, targetSha);
        while (step.kind === 'conflict') {
          if (ctx.signal.aborted) throw abortError();
          const current: Extract<RebaseStep, { kind: 'conflict' }> = step;

          if (conflicts.length + 1 > prfix.maxConflictCommits) {
            throw new ConflictCapError(
              `more than ${prfix.maxConflictCommits} conflicting commits (PRFIX_MAX_CONFLICT_COMMITS); ` +
                `stopped at ${current.commit.slice(0, 7)} "${current.subject}"`,
              current.files,
            );
          }
          if (current.files.length > prfix.maxConflictFiles) {
            throw new ConflictCapError(
              `commit ${current.commit.slice(0, 7)} "${current.subject}" conflicts in ${current.files.length} files, ` +
                `more than ${prfix.maxConflictFiles} (PRFIX_MAX_CONFLICT_FILES)`,
              current.files,
            );
          }
          // Binary, modify/delete, rename/delete and file/directory conflicts
          // carry no markers, and staging picks a side silently: no content
          // edit settles them, so no resolver call is spent on them.
          const unresolvable = await git.unresolvableConflicts(path);
          if (unresolvable.length > 0) {
            throw new UnresolvedConflictError(
              current.commit,
              unresolvable.map((u) => u.path),
              'binary or one-sided conflict (rebase it manually)',
            );
          }
          assertWithinCostCap(state, prfix.app.maxCostUsdPerWi, REBASE_STAGE);

          ctx.reportProgress?.(`conflict ${conflicts.length + 1} · ${current.commit.slice(0, 7)}`);
          ctx.logger.info(
            `${REBASE_STAGE}: resolving ${current.files.length} file(s) in ${current.commit.slice(0, 7)} "${current.subject}"`,
          );
          const before = await git.fingerprintFiles(path, current.files);
          const resolved = await resolveConflict({
            runner: deps.runner,
            config: prfix.app,
            promptTemplate: deps.promptTemplate,
            maxTurns: prfix.resolverMaxTurns,
            worktreePath: path,
            step: current,
            targetSha,
            prTitle: input.pr.title,
            state,
            signal: ctx.signal,
          });

          const remaining = await git.filesWithMarkers(path, current.files);
          if (remaining.length > 0) throw new UnresolvedConflictError(current.commit, remaining);
          // No markers is not proof of a resolution: a file the resolver never
          // touched (or deleted, which the prompt forbids) still holds
          // whatever git left there.
          const after = await git.fingerprintFiles(path, current.files);
          const untouched = current.files.filter((f) => after[f] == null || after[f] === before[f]);
          if (untouched.length > 0) {
            throw new UnresolvedConflictError(current.commit, untouched, 'resolver left conflicted files unchanged or deleted');
          }
          // continueRebase stages only the listed files; an edit anywhere else
          // would make `rebase --continue` fail confusingly, or ride along unpushed.
          const outside = (await git.unstagedChanges(path)).filter((f) => !current.files.includes(f));
          if (outside.length > 0) {
            throw new UnresolvedConflictError(current.commit, outside, 'resolver edited files outside the conflict');
          }

          conflicts.push({
            commit: current.commit,
            subject: current.subject,
            files: current.files,
            summary: resolved.summary,
            resolutions: resolved.files,
          });
          step = await git.continueRebase(path, current.files);
        }
        newHeadSha = step.head;
        // Whatever is on disk is what gets verified, and only HEAD is pushed:
        // they must be the same tree. Overlay files are in info/exclude.
        const dirty = await git.dirtyPaths(path);
        if (dirty.length > 0) {
          throw new Error(
            `rebase left files in the worktree that are not in the rebased commits (they would be verified but not pushed): ${dirty.join(', ')}`,
          );
        }
      } catch (err) {
        try {
          await git.abortRebase(path);
        } catch (abortErr) {
          const msg = abortErr instanceof Error ? abortErr.message : String(abortErr);
          ctx.logger.warn(`${REBASE_STAGE}: git rebase --abort failed after an error: ${msg}`);
        }
        throw err;
      }

      const commitsReplayed = await git.countCommits(path, targetSha);
      const rebase: RebaseOutput = {
        preRebaseSha,
        targetSha,
        newHeadSha,
        commitsReplayed,
        conflicts,
      };
      state.outputs.rebase = rebase;
      state.outputs.worktree = { ...worktree, baseSha: targetSha };
      return state;
    },
  };
}

function inputOf(state: { outputs: Record<string, unknown> }): PrFixInput {
  const input = state.outputs.prFixInput as PrFixInput | undefined;
  if (!input) throw new Error('fix-pr stages require state.outputs.prFixInput');
  return input;
}

/** Reads the PR, refuses one that is not an active, branch-to-branch PR. */
export function createPrIntakeStage(deps: { ado: AdoClient }): Stage {
  return {
    name: 'pr-intake',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const pr = await deps.ado.getPullRequest(input.repository, input.pullRequestId, { signal: ctx.signal });
      if (pr.status !== 'active') throw new Error(`PR ${input.pullRequestId} is ${pr.status}, not active`);
      if (!pr.sourceRefName || !pr.targetRefName) {
        throw new Error(`PR ${input.pullRequestId} has no source/target branch`);
      }
      state.outputs.prFixInput = { ...input, pr } satisfies PrFixInput;
      // build-and-test requires a wiContext; it reads only id and title.
      state.outputs.wiContext = {
        id: input.pullRequestId,
        title: pr.title,
        workItemType: 'Pull Request',
        state: pr.status,
        description: '',
        reproSteps: '',
        acceptanceCriteria: '',
        images: [],
        comments: [],
      } satisfies WorkItemContext;
      return state;
    },
  };
}

/**
 * Creates the PR worktree and applies the worktree overlay to it, exactly as
 * `worktree-setup` does for a WI: without it, `deploy --ruleset` points at a
 * missing file or the stricter committed ruleset applies. Overlay files are
 * added to `info/exclude`, so they never show as untracked.
 */
export function createPrWorktreeStage(deps: {
  git: PrFixGit;
  /** Test override for the overlay copier. */
  applyOverlay?: (sourceDir: string, worktreePath: string) => string[];
}): Stage {
  const overlay = deps.applyOverlay ?? ((src: string, wt: string) => applyWorktreeOverlay(src, wt));
  return {
    name: 'pr-worktree',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      const { pullRequestId, pr } = inputOf(state);
      const wt = await deps.git.createWorktree({
        pullRequestId,
        sourceRefName: pr.sourceRefName,
        targetRefName: pr.targetRefName,
        headCommit: pr.headCommit,
      });
      state.outputs.worktree = wt;
      for (const dir of ctx.config.worktreeOverlayDirs ?? []) {
        overlay(dir, wt.path);
      }
      if (await deps.git.isUpToDate(wt.path, wt.targetSha)) {
        throw new PrUpToDateError(`PR ${pullRequestId} already contains ${pr.targetRefName.replace(/^refs\/heads\//, '')}`);
      }
      return state;
    },
  };
}

/** Pushes the rebased head, leased on the head we rebased (a moved remote fails the push). */
export function createPushRebasedStage(deps: { git: PrFixGit }): Stage {
  return {
    name: 'push-rebased',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      const { pr } = inputOf(state);
      const wt = state.outputs.worktree as WorktreeContext | undefined;
      const rebase = state.outputs.rebase as RebaseOutput | undefined;
      if (!wt || !rebase) throw new Error('push-rebased requires state.outputs.worktree and .rebase');
      state.outputs.pushedCommit = await deps.git.headSha(wt.path);
      if (ctx.config.dryRun) return state;
      await deps.git.push({ path: wt.path, sourceRefName: pr.sourceRefName, expectedRemoteSha: rebase.preRebaseSha });
      // From here on the remote branch is the rebased one: fixPr reports any
      // later failure as `rebased` rather than claiming nothing changed.
      state.outputs.pushed = true;
      return state;
    },
  };
}

/**
 * Posts the success comment. Best-effort: it runs after the push, so a
 * failure here is logged rather than turning a pushed branch into a failed run.
 */
export function createPrCommentStage(deps: {
  ado: AdoClient;
  /** The environment survives the run (`--keep-env`); only then is it linked. */
  keepEnv?: boolean;
}): Stage {
  return {
    name: 'pr-comment',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      if (ctx.config.dryRun) return state;
      const input = inputOf(state);
      const rebase = state.outputs.rebase as RebaseOutput | undefined;
      if (!rebase) throw new Error('pr-comment requires state.outputs.rebase');
      const content = renderSuccessComment({
        pr: input.pr,
        rebase,
        verification: state.outputs.verification as VerificationOutput | undefined,
        environment: state.outputs.environment as EnvironmentOutput | undefined,
        skippedVerification: ctx.config.skipBuildTest,
        keepEnv: deps.keepEnv ?? false,
      });
      try {
        await deps.ado.createPullRequestThread(
          { repositoryName: input.repository, pullRequestId: input.pullRequestId, content },
          { signal: ctx.signal },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`pr-comment: success comment on PR ${input.pullRequestId} not posted :: ${redactPat(msg, ctx.config.pat)}`);
      }
      return state;
    },
  };
}

const RENUMBER_STAGE = 'renumber-collisions';

/** Vendored apps (`external/**`) and downloaded symbols (`.alpackages`) are never scanned. */
function isExcludedPath(file: string): boolean {
  return file.startsWith('external/') || file.split('/').includes('.alpackages');
}

const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/**
 * A file's text exactly as on disk, BOM included, so writing it back changes
 * only what was replaced. Invalid UTF-8 throws: decoding it lossily and
 * writing it back would corrupt bytes nobody meant to touch.
 */
function readText(abs: string): string {
  try {
    return UTF8.decode(readFileSync(abs));
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`${RENUMBER_STAGE}: ${abs} is not valid UTF-8; refusing to rewrite it`);
    throw err;
  }
}

function writeText(abs: string, text: string): void {
  writeFileSync(abs, Buffer.from(text, 'utf8'));
}

function wholeWord(id: number, flags = ''): RegExp {
  return new RegExp(String.raw`\b${id}\b`, flags);
}

/** `idRanges` (`[{from,to}]`), else the singular `idRange`; an app with neither has no usable ID. */
function readIdRanges(abs: string): { from: number; to: number }[] {
  const json = JSON.parse(readFileSync(abs, 'utf8').replace(/^﻿/, '')) as {
    idRanges?: { from?: unknown; to?: unknown }[];
    idRange?: { from?: unknown; to?: unknown };
  };
  const raw = Array.isArray(json.idRanges) ? json.idRanges : json.idRange ? [json.idRange] : [];
  return raw
    .map((r) => ({ from: Number(r?.from), to: Number(r?.to) }))
    .filter((r) => Number.isInteger(r.from) && Number.isInteger(r.to));
}

/** Deepest app directory that contains `file`; `''` is the repo root. */
function appOf(file: string, appDirs: string[]): string | undefined {
  let best: string | undefined;
  for (const dir of appDirs) {
    const inside = dir === '' || file.startsWith(`${dir}/`);
    if (inside && (best === undefined || dir.length > best.length)) best = dir;
  }
  return best;
}

const DECLARATION_LINE_RE = new RegExp(
  String.raw`^﻿?[ \t]*(${[...AL_OBJECT_TYPES].sort((a, b) => b.length - a.length).join('|')})[ \t]+(\d+)\b`,
  'im',
);

/**
 * Replace the ID on the object's declaration line and nothing else. The first
 * declaration in the file must still be `<type> <oldId>`, and the first
 * whole-word `oldId` on that line must be the declaration's own ID. Anything
 * else throws rather than guessing.
 */
function rewriteDeclaration(text: string, decl: AlDeclaration, newId: number): string {
  const m = DECLARATION_LINE_RE.exec(text);
  if (!m || (m[1] as string).toLowerCase() !== decl.type || Number(m[2]) !== decl.id) {
    throw new Error(`${RENUMBER_STAGE}: declaration of ${decl.type} ${decl.id} not found in ${decl.file}; nothing rewritten`);
  }
  const lineStart = m.index;
  const nl = text.indexOf('\n', lineStart);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const idOffset = m[0].length - (m[2] as string).length;
  const hit = wholeWord(decl.id).exec(line);
  if (!hit || hit.index !== idOffset) {
    throw new Error(
      `${RENUMBER_STAGE}: declaration line of ${decl.file} does not hold ${decl.id} exactly once where expected; nothing rewritten`,
    );
  }
  return text.slice(0, lineStart + hit.index) + String(newId) + text.slice(lineStart + hit.index + hit[0].length);
}

const appKey = (app: string, type: string, id: number) => `${app}\0${type}\0${id}`;

/**
 * Runs after the rebase. Renumbers every AL object the PR introduced whose ID
 * now collides with another declaration in the same app (same type and ID).
 * New IDs come from Object ID Ninja, and all edits land as one bot commit. No
 * LLM is involved.
 *
 * Refuses with IdCollisionError when a collision group does not have exactly
 * one PR-introduced member, or when a file the PR modified (not added)
 * mentions the old ID as a whole word: that reference could mean either
 * object. Both checks run before Ninja starts, so a refusal reserves nothing.
 *
 * Every ID Ninja assigns goes into `state.outputs.renumber.reserved` the
 * moment `assign` returns, so the caller can release it when the run ends
 * without a push, even if this stage throws later. An ID that is rejected
 * (outside the app's idRanges, or already declared) is not released here.
 */
export function createRenumberStage(deps: { git: PrFixGit; prfix: PrFixConfig; ninja: () => NinjaClient }): Stage {
  const { git, prfix } = deps;
  return {
    name: RENUMBER_STAGE,
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      if (!prfix.renumberCollisions) return state;
      const worktree = state.outputs.worktree as (WorktreeContext & { targetSha: string }) | undefined;
      if (!worktree) throw new Error(`${RENUMBER_STAGE} requires state.outputs.worktree`);
      const input = inputOf(state);
      const { path, targetSha } = worktree;

      // 1. App directories: every app.json outside external/ and .alpackages.
      const appDirs = (await git.listFiles(path, '*app.json'))
        .filter((f) => (f === 'app.json' || f.endsWith('/app.json')) && !isExcludedPath(f))
        .map((f) => (f === 'app.json' ? '' : f.slice(0, -'/app.json'.length)));

      // 2-3. Declarations at HEAD. The rebase stage leaves the worktree exactly at HEAD.
      const decls: AlDeclaration[] = [];
      for (const file of await git.listFiles(path, '*.al')) {
        if (isExcludedPath(file)) continue;
        const app = appOf(file, appDirs);
        if (app === undefined) continue;
        const parsed = parseDeclaration(readFileSync(join(path, file), 'utf8'));
        if (parsed) decls.push({ ...parsed, file, app });
      }
      const output: RenumberOutput = { commit: null, renumbered: [], reserved: [] };
      const groups = findCollisions(decls);
      if (groups.length === 0) {
        state.outputs.renumber = output;
        return state;
      }

      // 4. PR-introduced: in a file the PR added or modified, and not declared
      //    with the same (type, id) by that path at the target.
      const changed = await git.changedFiles(path, targetSha);
      const touchedByPr = new Set(changed.filter((c) => c.status !== 'D').map((c) => c.file));
      const introduced = new Set<AlDeclaration>();
      for (const d of groups.flatMap((g) => g.members)) {
        if (!touchedByPr.has(d.file)) continue;
        const before = await git.showFileAtRef(path, targetSha, d.file);
        const old = before === null ? null : parseDeclaration(before);
        if (!old || old.type !== d.type || old.id !== d.id) introduced.add(d);
      }

      // 5a. Plan, then refuse ambiguous references before any ID is reserved.
      const plans = planRenumbers(groups, (d) => introduced.has(d));
      const modified = changed.filter((c) => c.status === 'M').map((c) => c.file);
      const added = changed.filter((c) => c.status === 'A' && !isExcludedPath(c.file)).map((c) => c.file);
      for (const { target, keep } of plans) {
        for (const file of modified) {
          if (file === target.file) continue;
          // Byte-level (latin1) read: the IDs are ASCII, and nothing here is written back.
          if (!wholeWord(target.id).test(readFileSync(join(path, file)).toString('latin1'))) continue;
          const group: CollisionGroup = { app: target.app, type: target.type, id: target.id, members: [target, ...keep] };
          throw new IdCollisionError(
            [group],
            `${target.type} ${target.id} (${target.file}) collides in ${target.app}, and ${file}, which the PR modified ` +
              `but did not add, mentions ${target.id}: it is ambiguous which object it means, so nothing was renumbered`,
          );
        }
      }

      const rangesByApp = new Map<string, { from: number; to: number }[]>();
      const rangesOf = (app: string) => {
        let r = rangesByApp.get(app);
        if (!r) {
          r = readIdRanges(join(path, app, 'app.json'));
          rangesByApp.set(app, r);
        }
        return r;
      };
      // Declared at HEAD, plus whatever this run has already handed out.
      const taken = new Set(decls.map((d) => appKey(d.app, d.type, d.id)));

      state.outputs.renumber = output;
      const touched = new Set<string>();
      let client: NinjaClient | undefined;
      try {
        client = deps.ninja();
        for (const [i, { target }] of plans.entries()) {
          if (ctx.signal.aborted) {
            const err = new Error(`${RENUMBER_STAGE} aborted`);
            err.name = 'AbortError';
            throw err;
          }
          ctx.reportProgress?.(`renumber ${i + 1}/${plans.length}`);
          const abs = join(path, target.file);

          // 5b. Ask Ninja until it hands out an ID that is in range and free in this app.
          let newId: number | undefined;
          for (let attempt = 1; attempt <= NINJA_MAX_ASSIGN_ATTEMPTS && newId === undefined; attempt++) {
            const id = await client.assign(target.type, abs);
            output.reserved.push({ type: target.type, id, file: abs });
            const inRange = rangesOf(target.app).some((r) => id >= r.from && id <= r.to);
            if (inRange && !taken.has(appKey(target.app, target.type, id))) {
              newId = id;
            } else {
              ctx.logger.warn(
                `${RENUMBER_STAGE}: Ninja assigned ${target.type} ${id} for ${target.file}, which is ` +
                  `${inRange ? 'already declared in the app' : `outside ${target.app}'s idRanges`}; asking again`,
              );
            }
          }
          if (newId === undefined) throw new Error(`ninja: no usable ${target.type} ID for ${target.file}`);
          taken.add(appKey(target.app, target.type, newId));

          // 6. The declaration line, then every whole-word mention in the PR's other added files.
          writeText(abs, rewriteDeclaration(readText(abs), target, newId));
          touched.add(target.file);
          for (const file of added) {
            if (file === target.file) continue;
            const fileAbs = join(path, file);
            // Cheap byte-level pre-check, so binaries and unrelated files are never decoded.
            if (!wholeWord(target.id).test(readFileSync(fileAbs).toString('latin1'))) continue;
            writeText(fileAbs, readText(fileAbs).replace(wholeWord(target.id, 'g'), String(newId)));
            touched.add(file);
          }
          output.renumbered.push({
            type: target.type,
            name: target.name,
            file: target.file,
            app: target.app,
            oldId: target.id,
            newId,
          });
          ctx.logger.info(`${RENUMBER_STAGE}: ${target.type} ${target.name} ${target.id} -> ${newId} (${target.file})`);
        }

        // 7. One bot commit for the whole run.
        const short = input.pr.targetRefName.replace(/^refs\/heads\//, '');
        const message =
          `fix: renumber AL object IDs that collide with ${short}\n\n` +
          output.renumbered.map((r) => `${r.type} ${r.name} ${r.oldId} -> ${r.newId} (${r.file})`).join('\n');
        output.commit = await git.commitFiles(path, [...touched], message);
      } finally {
        if (client) {
          try {
            await client.close();
          } catch (err) {
            ctx.logger.warn(`${RENUMBER_STAGE}: closing the Ninja client failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return state;
    },
  };
}
