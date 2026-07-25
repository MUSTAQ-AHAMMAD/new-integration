/**
 * Runs `worker` over `items` with at most `concurrency` promises in flight,
 * invoking `onEach(done)` after each item completes. Never rejects — the worker
 * must catch its own per-item errors — so one bad item can't abort the batch.
 *
 * Used to overlap I/O-bound work (DB upserts, Oracle SOAP calls) that would
 * otherwise run strictly one-at-a-time.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onEach?: (done: number) => void,
): Promise<void> {
  let cursor = 0;
  let done = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
      done += 1;
      if (onEach) onEach(done);
    }
  };
  const lanes = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    () => runNext(),
  );
  await Promise.all(lanes);
}
