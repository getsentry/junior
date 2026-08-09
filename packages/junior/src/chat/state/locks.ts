import type { Lock, StateAdapter } from "chat";

export const ACTIVE_LOCK_TTL_MS = 90_000;

/**
 * Acquire a lock for long-running work that the queued state adapter should
 * keep alive while the owning invocation is still making progress.
 */
export async function acquireActiveLock(
  state: StateAdapter,
  threadId: string,
): Promise<Lock | null> {
  return await state.acquireLock(threadId, ACTIVE_LOCK_TTL_MS);
}

export type LockAttempt<T> = { acquired: false } | { acquired: true; value: T };

/** Run work under the active lock, reporting contention without ambiguity. */
export async function withActiveLock<T>(
  state: StateAdapter,
  key: string,
  run: () => Promise<T>,
): Promise<LockAttempt<T>> {
  const lock = await acquireActiveLock(state, key);
  if (!lock) return { acquired: false };
  try {
    return { acquired: true, value: await run() };
  } finally {
    await state.releaseLock(lock);
  }
}
