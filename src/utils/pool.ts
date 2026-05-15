export interface PoolError<T> {
  item: T;
  error: unknown;
}

export interface PoolResult<T> {
  errors: PoolError<T>[];
}

export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<PoolResult<T>> {
  const queue = [...items];
  const errors: PoolError<T>[] = [];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  if (queue.length === 0) return { errors };

  const drainOne = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift() as T;
      try {
        await worker(item);
      } catch (error) {
        errors.push({ item, error });
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) runners.push(drainOne());
  await Promise.all(runners);
  return { errors };
}
