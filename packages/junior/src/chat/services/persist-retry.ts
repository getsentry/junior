/**
 * Shared post-delivery persist retry.
 *
 * Delivered outcomes the user already saw must not be lost to a transient
 * state-write failure, so both the Slack reply executor and the dispatch
 * runner retry these persists with the same short linear backoff.
 */
const PERSIST_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a delivered-state persist briefly before surfacing the failure. */
export async function persistWithRetry(
  persist: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await persist();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PERSIST_ATTEMPTS) {
        await sleep(attempt * 100);
      }
    }
  }
  throw lastError;
}
