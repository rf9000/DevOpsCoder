export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  targetRepoPath: string;
  worktreeBase: string;
  triggerTag: string;
  blockedTag: string;
  needInputTag: string;
  pollIntervalMinutes: number;
  concurrency: number;
  maxRevisions: number;
  maxRejectCycles: number;
  claudeModel: string;
  stateDir: string;
  assignedToFilter: string[];
  dryRun: boolean;
}

export type StageOutcome = 'success' | 'failure' | 'skip' | 'pause' | 'reject';

export interface StageHistoryEntry {
  stage: string;
  startedAt: string;
  endedAt: string;
  outcome: StageOutcome;
  message?: string;
}

export interface PipelineTerminalError {
  stage: string;
  message: string;
  at: string;
}

export interface PipelineRejection {
  reasons: string[];
  summary: string;
  questions?: string[];
  stage: string;
  at: string;
}

export interface PipelineState {
  workItemId: number;
  slug: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelled?: boolean;
  terminalError?: PipelineTerminalError;
  rejection?: PipelineRejection;
  rejectCount?: number;
  currentStage: string | null;
  history: StageHistoryEntry[];
  attempts: Record<string, number>;
  outputs: Record<string, unknown>;
}

export interface WorkItemReference {
  id: number;
  url?: string;
}

export interface WiqlQueryResponse {
  workItems: WorkItemReference[];
}

export interface WorkItemFields {
  'System.Title'?: string;
  'System.State'?: string;
  'System.Tags'?: string;
  'System.AssignedTo'?: { displayName?: string; uniqueName?: string } | string;
}

export interface WorkItem {
  id: number;
  rev?: number;
  fields: WorkItemFields;
  url?: string;
}

export interface CommentResponse {
  id?: number;
  text?: string;
  createdDate?: string;
}

export type ProcessOutcome =
  | { kind: 'completed'; workItemId: number }
  | { kind: 'paused'; workItemId: number; stage: string }
  | { kind: 'failed'; workItemId: number; error: PipelineTerminalError }
  | { kind: 'skipped'; workItemId: number; reason: string };

export interface CycleStats {
  considered: number;
  completed: number;
  paused: number;
  failed: number;
  skipped: number;
}
