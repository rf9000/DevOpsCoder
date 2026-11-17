import type { ActivePullRequest } from '../../types/index.ts';

/**
 * The active PRs of the configured repository, refreshed on a timer and after
 * each job so `/status` never calls ADO. A failed refresh keeps the previous
 * list and records the error.
 */
export class PrFixCatalog {
  prs: ActivePullRequest[] = [];
  /** ISO time of the last successful refresh; null until one succeeds. */
  at: string | null = null;
  error: string | null = null;

  constructor(
    private readonly list: () => Promise<ActivePullRequest[]>,
    private readonly now: () => Date,
  ) {}

  async refresh(): Promise<void> {
    try {
      const prs = await this.list();
      this.prs = prs;
      this.at = this.now().toISOString();
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  find(prId: number): ActivePullRequest | undefined {
    return this.prs.find((p) => p.id === prId);
  }
}
