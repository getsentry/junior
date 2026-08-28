import { setTimeout as wait } from "node:timers/promises";
import type { Lock, StateAdapter } from "chat";

/** One lock held in shared ACP state. */
export type AcpLock = Lock;

/** Shared state operations required by the ACP transport. */
export type AcpState = Pick<
  StateAdapter,
  | "acquireLock"
  | "appendToList"
  | "delete"
  | "extendLock"
  | "get"
  | "getList"
  | "releaseLock"
  | "set"
>;

export const MUTATION_LOCK_TTL_MS = 10_000;

type LockAttempt<T> = { acquired: false } | { acquired: true; value: T };

/** Run one ACP state mutation while its shared lock remains owned. */
export async function withLock<T>(
  state: AcpState,
  key: string,
  run: (lock: AcpLock) => Promise<T>,
  options: {
    keepAlive?: boolean;
    retryMs?: number;
    ttlMs?: number;
    waitMs?: number;
  } = {},
): Promise<LockAttempt<T>> {
  const ttlMs = options.ttlMs ?? MUTATION_LOCK_TTL_MS;
  const startedAtMs = Date.now();
  let lock: AcpLock | null;
  while (true) {
    lock = await state.acquireLock(key, ttlMs);
    if (lock) break;
    if (Date.now() - startedAtMs >= (options.waitMs ?? 0)) {
      return { acquired: false };
    }
    await wait(options.retryMs ?? 25, undefined, { ref: false });
  }
  const heartbeat = options.keepAlive
    ? setInterval(
        () => void state.extendLock(lock, ttlMs).catch(() => undefined),
        Math.floor(ttlMs / 3),
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

/** Prove ACP lock ownership immediately before a blind state write. */
export async function fenceLock(
  state: AcpState,
  lock: AcpLock,
  ttlMs = MUTATION_LOCK_TTL_MS,
): Promise<void> {
  if (!(await state.extendLock(lock, ttlMs))) {
    throw new Error(
      `ACP lock ownership was lost before write for ${lock.threadId}`,
    );
  }
}
