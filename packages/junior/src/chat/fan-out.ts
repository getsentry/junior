import pLimit from "p-limit";

/**
 * Calls that one fan-out of independent reads or writes runs at once. Use it
 * through `mapBounded` unless a provider rate limit needs a lower cap.
 */
export const FAN_OUT_CONCURRENCY = 8;

/**
 * Map each item through `fn`, with at most `concurrency` calls at once. The
 * results keep the order of `items`. Use it for independent work over a list
 * whose length the code does not fix.
 */
export async function mapBounded<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => PromiseLike<R> | R,
  concurrency: number = FAN_OUT_CONCURRENCY,
): Promise<R[]> {
  return await pLimit(concurrency).map(items, fn);
}
