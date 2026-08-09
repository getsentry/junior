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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/** Run work under one lock, optionally waiting for the current owner. */
export async function withLock<T>(
  state: StateAdapter,
  key: string,
  run: () => Promise<T>,
  options: { retryMs?: number; waitMs?: number } = {},
): Promise<LockAttempt<T>> {
  const startedAtMs = Date.now();
  let lock: Lock | null;
  while (true) {
    lock = await acquireActiveLock(state, key);
    if (lock) break;
    if (Date.now() - startedAtMs >= (options.waitMs ?? 0)) {
      return { acquired: false };
    }
    await sleep(options.retryMs ?? 25);
  }
  try {
    return { acquired: true, value: await run() };
  } finally {
    await state.releaseLock(lock);
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
