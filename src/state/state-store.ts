import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import type { PipelineState } from '../types/index.ts';

export class PipelineStateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(workItemId: number): string {
    return join(this.dir, `${workItemId}.json`);
  }

  load(workItemId: number): PipelineState | null {
    const path = this.filePath(workItemId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PipelineState>;
      if (typeof parsed.workItemId !== 'number') return null;
      return parsed as PipelineState;
    } catch {
      return null;
    }
  }

  save(state: PipelineState): void {
    mkdirSync(this.dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(
      this.filePath(state.workItemId),
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  }

  delete(workItemId: number): void {
    const path = this.filePath(workItemId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  listAll(): PipelineState[] {
    if (!existsSync(this.dir)) return [];
    const result: PipelineState[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const id = Number(file.slice(0, -'.json'.length));
      if (!Number.isFinite(id)) continue;
      const s = this.load(id);
      if (s) result.push(s);
    }
    return result;
  }

  listResumable(): PipelineState[] {
    return this.listAll().filter(
      (s) => !s.completedAt && !s.terminalError && !s.cancelled && !s.rejection,
    );
  }
}
