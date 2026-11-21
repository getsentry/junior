/** Run `task` on each item, at most `limit` at a time, and keep the order. */
export async function mapBounded(items, limit, task) {
  const results = [];
  let next = 0;
  async function drain() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, drain),
  );
  return results;
}
