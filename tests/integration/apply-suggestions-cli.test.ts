import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('bun', ['run', CLI, ...args], { encoding: 'utf-8' });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('apply-suggestions CLI', () => {
  it('prints ok:false JSON as the last line and exits 0 for invalid input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sugg-cli-'));
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify({ mode: 'nope' }), 'utf-8');
    const { code, stdout } = await cli(['apply-suggestions', '--input', file]);
    expect(code).toBe(0);
    const last = stdout.trim().split('\n').at(-1)!;
    const outcome = JSON.parse(last) as { ok: boolean; error: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toStartWith('invalid-input:');
  });

  it('exits non-zero without --input', async () => {
    expect((await cli(['apply-suggestions'])).code).not.toBe(0);
  });
});
