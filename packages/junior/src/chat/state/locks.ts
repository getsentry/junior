import { setTimeout as sleep } from "node:timers/promises";
import type { Lock, StateAdapter } from "chat";

export const ACTIVE_LOCK_TTL_MS = 90_000;
export const MUTATION_LOCK_TTL_MS = 10_000;

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

/** Run work under one lock, optionally waiting for the current owner. */
export async function withLock<T>(
  state: StateAdapter,
  key: string,
  run: (lock: Lock) => Promise<T>,
  options: { retryMs?: number; ttlMs?: number; waitMs?: number } = {},
): Promise<LockAttempt<T>> {
  const startedAtMs = Date.now();
  let lock: Lock | null;
  while (true) {
    lock = await state.acquireLock(key, options.ttlMs ?? ACTIVE_LOCK_TTL_MS);
    if (lock) break;
    if (Date.now() - startedAtMs >= (options.waitMs ?? 0)) {
      return { acquired: false };
    }
    await sleep(options.retryMs ?? 25, undefined, { ref: false });
  }
  try {
    return { acquired: true, value: await run(lock) };
  } finally {
    await state.releaseLock(lock);
  }
}

/**
 * Prove lock ownership immediately before a blind write.
 *
 * Whole-record mutations must stop if their lock expired rather than overwrite
 * state committed by a newer owner.
 */
export async function fenceLock(
  state: StateAdapter,
  lock: Lock,
  ttlMs = MUTATION_LOCK_TTL_MS,
): Promise<void> {
  if (!(await state.extendLock(lock, ttlMs))) {
    throw new Error(
      `Lock ownership was lost before write for ${lock.threadId}`,
    );
  }
}

/** Run work under the active lock, reporting contention without ambiguity. */
export async function withActiveLock<T>(
  state: StateAdapter,
  key: string,
  run: () => Promise<T>,
): Promise<LockAttempt<T>> {
  return await withLock(state, key, run);
}
