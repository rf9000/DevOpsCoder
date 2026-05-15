import { describe, it, expect } from 'bun:test';
import { runPool } from '../../src/utils/pool.ts';

describe('runPool', () => {
  it('processes every item exactly once', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const result = await runPool(items, 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(result.errors).toEqual([]);
  });

  it('runs at most N items concurrently', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await runPool(items, 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('isolates worker errors and continues draining the queue', async () => {
    const items = [1, 2, 3, 4];
    const succeeded: number[] = [];
    const result = await runPool(items, 2, async (n) => {
      if (n === 2) throw new Error(`fail-${n}`);
      succeeded.push(n);
    });
    expect(succeeded.sort((a, b) => a - b)).toEqual([1, 3, 4]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.item).toBe(2);
    expect((result.errors[0]?.error as Error).message).toBe('fail-2');
  });

  it('handles empty input without spawning workers', async () => {
    const result = await runPool<number>([], 4, async () => {
      throw new Error('should not run');
    });
    expect(result.errors).toEqual([]);
  });
});
