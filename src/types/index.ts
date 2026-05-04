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

export type StageOutcome = 'success' | 'failure' | 'skip' | 'pause';

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

export interface PipelineState {
  workItemId: number;
  slug: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelled?: boolean;
  terminalError?: PipelineTerminalError;
  currentStage: string | null;
  history: StageHistoryEntry[];
  attempts: Record<string, number>;
  outputs: Record<string, unknown>;
}
