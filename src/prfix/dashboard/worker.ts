import type { ActivePullRequest } from '../../types/index.ts';
import type { Logger } from '../../utils/logger.ts';
import type { PrFixOutcome } from '../types.ts';
import type { PrFixCatalog } from './catalog.ts';
import type { ActiveJob, HistoryLine, PendingApproval, PrFixJobStore, QueueEntry } from './store.ts';

export interface PrFixWorkerDeps {
  store: PrFixJobStore;
  catalog: PrFixCatalog;
  repo: string;
  /** Non-null when the PR fixer cannot run (e.g. its config failed to load). */
  unavailableReason: string | null;
  signInNeeded: () => boolean;
  wiRunningForPr: (prId: number) => boolean;
  runJob: (prId: number, onProgress: (stage: string, detail: string | null) => void) => Promise<PrFixOutcome>;
  approve: (prId: number) => Promise<PrFixOutcome>;
  reject: (prId: number) => Promise<PrFixOutcome>;
  cleanupInterrupted: (prId: number) => Promise<void>;
  ttlHours: number;
  logger: Logger;
  now: () => Date;
  /**
   * True once the watcher is shutting down: nothing new starts (a queued job
   * or an approve would only run into the abort and be lost), so the queue and
   * the pending approvals survive the restart. Default: never.
   */
  stopping?: () => boolean;
}

export type WorkerResult = { ok: true } | { ok: false; code: 400 | 404 | 409; error: string };

export type PrFixPrState = 'idle' | 'queued' | 'running' | 'awaiting-approval';

export interface PrFixStatusView {
  available: boolean;
  unavailableReason: string | null;
  repo: string;
  prs: Array<ActivePullRequest & { state: PrFixPrState; lastRun: HistoryLine | null }>;
  prsAt: string | null;
  prsError: string | null;
  queue: QueueEntry[];
  pending: PendingApproval[];
  activeJob:
    | (ActiveJob & { phase: string | null; phaseDetail: string | null; phaseSince: string | null; phasesDone: string[] })
    | null;
  waiting: 'signin' | null;
}

export interface PrFixWorker {
  enqueue(prId: number, user: string): WorkerResult;
  unqueue(prId: number): WorkerResult;
  requestApprove(prId: number, user: string): WorkerResult;
  requestReject(prId: number, user: string): WorkerResult;
  status(): PrFixStatusView;
  /** Every finished job, newest first (`GET /stats`). */
  history(): HistoryLine[];
  recover(): Promise<void>;
  expire(): void;
  tick(): void;
  idle(): Promise<void>;
}

/** An approve/reject waiting for the worker; runs ahead of queued jobs. */
interface Decision {
  kind: 'approve' | 'reject';
  prId: number;
  user: string;
}

interface Phase {
  phase: string | null;
  phaseDetail: string | null;
  phaseSince: string | null;
  phasesDone: string[];
}

const NO_PHASE: Phase = { phase: null, phaseDetail: null, phaseSince: null, phasesDone: [] };

function failureOutcome(prId: number, error: string): PrFixOutcome {
  return {
    ok: false,
    status: 'error',
    error,
    pullRequestId: prId,
    oldHead: null,
    newHead: null,
    conflicts: [],
    renumbered: [],
    costUsd: 0,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs dashboard fix-pr jobs one at a time: approve/reject decisions first,
 * then the queue head. Everything runs in one process; `inFlight` (not
 * `active.json`) is what keeps a second action from starting.
 */
export function createPrFixWorker(deps: PrFixWorkerDeps): PrFixWorker {
  const { store, catalog, logger } = deps;
  const decisions: Decision[] = [];
  let inFlight: Promise<void> | null = null;
  /** The PR of the action in flight, set synchronously when it starts. */
  let runningPr: number | null = null;
  let phase: Phase = NO_PHASE;

  const iso = () => deps.now().toISOString();
  const duration = (startedAt: string) => deps.now().getTime() - new Date(startedAt).getTime();

  function onProgress(stage: string, detail: string | null): void {
    if (stage === phase.phase) {
      phase = { ...phase, phaseDetail: detail };
      return;
    }
    phase = {
      phase: stage,
      phaseDetail: detail,
      phaseSince: iso(),
      phasesDone: phase.phase ? [...phase.phasesDone, phase.phase] : phase.phasesDone,
    };
  }

  async function runQueuedJob(entry: QueueEntry): Promise<void> {
    const title = entry.title ?? catalog.find(entry.prId)?.title ?? '';
    const job: ActiveJob = { prId: entry.prId, startedAt: iso(), triggeredBy: entry.queuedBy, title };
    store.setActive(job);
    logger.info(`fix-pr: PR ${entry.prId} started (triggered by ${entry.queuedBy})`);
    let outcome: PrFixOutcome;
    try {
      outcome = await deps.runJob(entry.prId, onProgress);
    } catch (err) {
      logger.error(`fix-pr: PR ${entry.prId} job threw`, err);
      outcome = failureOutcome(entry.prId, message(err));
    }
    if (outcome.status === 'awaiting-approval' && outcome.review) {
      const readyAt = deps.now();
      const expiresAt = new Date(readyAt.getTime() + deps.ttlHours * 3_600_000);
      store.setPending([
        ...store.pending().filter((p) => p.prId !== entry.prId),
        {
          prId: entry.prId,
          title,
          triggeredBy: entry.queuedBy,
          readyAt: readyAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          review: outcome.review,
        },
      ]);
    } else {
      store.appendHistory({
        at: iso(),
        prId: entry.prId,
        title,
        triggeredBy: entry.queuedBy,
        durationMs: duration(job.startedAt),
        outcome,
      });
    }
    logger.info(`fix-pr: PR ${entry.prId} ended ${outcome.status}`);
  }

  async function runDecision(decision: Decision, item: PendingApproval): Promise<void> {
    // active.json first, then the pending item is dropped as the action
    // starts: approve consumes the state's hold marker at once, so the item
    // can never be acted on again whatever the outcome (or a restart
    // mid-action) turns out to be. In that order a crash between the two
    // writes leaves the item pending and re-approvable — recover() records the
    // interruption and its cleanup leaves a still-held state alone — rather
    // than a held state no pending item points at.
    const job: ActiveJob = { prId: decision.prId, startedAt: iso(), triggeredBy: item.triggeredBy, title: item.title };
    store.setActive(job);
    store.setPending(store.pending().filter((p) => p.prId !== decision.prId));
    logger.info(`fix-pr: PR ${decision.prId} ${decision.kind} by ${decision.user}`);
    let outcome: PrFixOutcome;
    try {
      outcome = await (decision.kind === 'approve' ? deps.approve : deps.reject)(decision.prId);
    } catch (err) {
      logger.error(`fix-pr: PR ${decision.prId} ${decision.kind} threw`, err);
      outcome = failureOutcome(decision.prId, message(err));
    }
    store.appendHistory({
      at: iso(),
      prId: decision.prId,
      title: item.title,
      triggeredBy: item.triggeredBy,
      durationMs: duration(job.startedAt),
      outcome,
      ...(decision.kind === 'approve' ? { approvedBy: decision.user } : { rejectedBy: decision.user }),
    });
    logger.info(`fix-pr: PR ${decision.prId} ${decision.kind} ended ${outcome.status}`);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      logger.error('fix-pr: worker action failed', err);
    }
    try {
      store.setActive(null);
    } catch (err) {
      logger.error('fix-pr: could not clear active.json', err);
    }
    phase = NO_PHASE;
    await catalog.refresh();
    runningPr = null;
    inFlight = null;
    // Nothing awaits this promise: a throw here (an unreadable or unwritable
    // queue file) would be an unhandled rejection, which ends the process and
    // every work item running in it.
    try {
      tick();
    } catch (err) {
      logger.error('fix-pr: could not start the next job', err);
    }
  }

  function tick(): void {
    if (inFlight || deps.unavailableReason !== null || deps.stopping?.() || deps.signInNeeded()) return;
    const decision = decisions.shift();
    if (decision) {
      const item = store.pending().find((p) => p.prId === decision.prId);
      if (!item) {
        tick();
        return;
      }
      runningPr = decision.prId;
      inFlight = run(() => runDecision(decision, item));
      return;
    }
    const [head, ...rest] = store.queue();
    if (!head) return;
    store.setQueue(rest);
    runningPr = head.prId;
    phase = NO_PHASE;
    inFlight = run(() => runQueuedJob(head));
  }

  function requestDecision(kind: Decision['kind'], prId: number, user: string): WorkerResult {
    const existing = decisions.find((d) => d.prId === prId);
    if (existing) return { ok: false, code: 409, error: `${existing.kind} already requested` };
    if (!store.pending().some((p) => p.prId === prId)) {
      return { ok: false, code: 404, error: `PR ${prId} is not awaiting approval` };
    }
    decisions.unshift({ kind, prId, user });
    tick();
    return { ok: true };
  }

  return {
    enqueue(prId, user) {
      if (deps.unavailableReason !== null) return { ok: false, code: 409, error: deps.unavailableReason };
      if (catalog.at === null) {
        return { ok: false, code: 409, error: catalog.error ? `PR list not loaded yet: ${catalog.error}` : 'PR list not loaded yet' };
      }
      if (runningPr === prId) return { ok: false, code: 409, error: 'already running' };
      if (store.pending().some((p) => p.prId === prId)) {
        return { ok: false, code: 409, error: 'awaiting approval; approve or reject first' };
      }
      const queue = store.queue();
      if (queue.some((q) => q.prId === prId)) return { ok: false, code: 409, error: 'already queued' };
      const pr = catalog.find(prId);
      if (!pr) return { ok: false, code: 409, error: `PR ${prId} is not an active PR` };
      if (deps.wiRunningForPr(prId)) return { ok: false, code: 409, error: 'a work item is running on this PR' };
      store.setQueue([...queue, { prId, queuedBy: user, queuedAt: iso(), title: pr.title }]);
      tick();
      return { ok: true };
    },

    unqueue(prId) {
      const queue = store.queue();
      if (!queue.some((q) => q.prId === prId)) return { ok: false, code: 404, error: `PR ${prId} is not queued` };
      store.setQueue(queue.filter((q) => q.prId !== prId));
      return { ok: true };
    },

    requestApprove: (prId, user) => requestDecision('approve', prId, user),
    requestReject: (prId, user) => requestDecision('reject', prId, user),

    status() {
      const queue = store.queue();
      const pending = store.pending();
      const history = store.history();
      const active = store.active();
      const stateOf = (prId: number): PrFixPrState => {
        if (runningPr === prId) return 'running';
        if (pending.some((p) => p.prId === prId)) return 'awaiting-approval';
        if (queue.some((q) => q.prId === prId)) return 'queued';
        return 'idle';
      };
      const waitingWork = decisions.length > 0 || queue.length > 0;
      return {
        available: deps.unavailableReason === null,
        unavailableReason: deps.unavailableReason,
        repo: deps.repo,
        prs: catalog.prs.map((pr) => ({
          ...pr,
          state: stateOf(pr.id),
          lastRun: history.find((h) => h.prId === pr.id) ?? null,
        })),
        prsAt: catalog.at,
        prsError: catalog.error,
        queue,
        pending,
        activeJob: active ? { ...active, ...phase, phasesDone: [...phase.phasesDone] } : null,
        waiting: !inFlight && waitingWork && deps.signInNeeded() ? 'signin' : null,
      };
    },

    history: () => store.history(),

    async recover() {
      const active = store.active();
      if (!active) return;
      logger.warn(`fix-pr: PR ${active.prId} was interrupted by a restart; recording and cleaning up`);
      store.appendHistory({
        at: iso(),
        prId: active.prId,
        title: active.title,
        triggeredBy: active.triggeredBy,
        durationMs: null,
        outcome: failureOutcome(active.prId, 'interrupted (container restarted)'),
      });
      try {
        await deps.cleanupInterrupted(active.prId);
      } catch (err) {
        logger.error(`fix-pr: cleanup of interrupted PR ${active.prId} failed`, err);
      }
      store.setActive(null);
    },

    expire() {
      const now = deps.now().getTime();
      for (const item of store.pending()) {
        if (new Date(item.expiresAt).getTime() > now) continue;
        if (decisions.some((d) => d.prId === item.prId) || runningPr === item.prId) continue;
        logger.info(`fix-pr: PR ${item.prId} approval expired; rejecting`);
        decisions.push({ kind: 'reject', prId: item.prId, user: 'expired' });
      }
      tick();
    },

    tick,

    async idle() {
      while (inFlight) await inFlight;
    },
  };
}
