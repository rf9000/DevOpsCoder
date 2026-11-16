import { describe, test, expect } from 'bun:test';
import { runProcess } from '../../src/services/process-runner.ts';

describe('runProcess', () => {
  test('streams each output line to onLine', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      ['bun', '-e', 'console.log("a"); console.error("b")'],
      process.cwd(),
      undefined,
      30_000,
      (line) => lines.push(line),
    );
    expect(lines).toContain('a');
    expect(lines).toContain('b');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a');
  });

  test('marks timedOut', async () => {
    const result = await runProcess(['bun', '-e', 'setTimeout(()=>{}, 5000)'], process.cwd(), undefined, 200);
    expect(result.timedOut).toBe(true);
  });
});
