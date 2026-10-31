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

type LockAttempt<T> = { acquired: false } | { acquired: true; value: T };

/** State operations that `withLock` and `fenceLock` need. */
export type LockState = Pick<
  StateAdapter,
  "acquireLock" | "extendLock" | "releaseLock"
>;

/**
 * Run work under one lock, optionally waiting for the current owner.
 * `keepAlive` is for multi-store mutations that must retain ownership until all
 * side effects finish; callers should still fence each blind write.
 */
export async function withLock<T>(
  state: LockState,
  key: string,
  run: (lock: Lock) => Promise<T>,
  options: {
    keepAlive?: boolean;
    retryMs?: number;
    ttlMs?: number;
    waitMs?: number;
  } = {},
): Promise<LockAttempt<T>> {
  const ttlMs = options.ttlMs ?? ACTIVE_LOCK_TTL_MS;
  const startedAtMs = Date.now();
  let lock: Lock | null;
  while (true) {
    lock = await state.acquireLock(key, ttlMs);
    if (lock) break;
    if (Date.now() - startedAtMs >= (options.waitMs ?? 0)) {
      return { acquired: false };
    }
    await sleep(options.retryMs ?? 25, undefined, { ref: false });
  }
  const heartbeat = options.keepAlive
    ? setInterval(
        // A failed extend is caught by the next fenceLock before any write.
        () => void state.extendLock(lock, ttlMs).catch(() => undefined),
        Math.max(1, Math.floor(ttlMs / 3)),
      )
    : undefined;
  heartbeat?.unref();
  try {
    return { acquired: true, value: await run(lock) };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
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
  state: LockState,
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
