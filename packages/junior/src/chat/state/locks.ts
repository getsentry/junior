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
