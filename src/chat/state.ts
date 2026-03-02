import { createRedisState, type RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, StateAdapter } from "chat";
import { hasRedisConfig } from "@/chat/config";
import { logInfo } from "@/chat/observability";

const MIN_LOCK_TTL_MS = 1000 * 60 * 5;

function createQueuedStateAdapter(base: StateAdapter): StateAdapter {
  const acquireLock = async (threadId: string, ttlMs: number): Promise<Lock | null> => {
    const effectiveTtlMs = Math.max(ttlMs, MIN_LOCK_TTL_MS);
    const lock = await base.acquireLock(threadId, effectiveTtlMs);
    if (!lock) return null;
    logInfo(
      "thread_lock_acquired",
      {},
      {
        "messaging.message.conversation_id": threadId
      },
      "Acquired thread lock"
    );
    return lock;
  };

  return {
    connect: () => base.connect(),
    disconnect: () => base.disconnect(),
    subscribe: (threadId) => base.subscribe(threadId),
    unsubscribe: (threadId) => base.unsubscribe(threadId),
    isSubscribed: (threadId) => base.isSubscribed(threadId),
    acquireLock,
    releaseLock: (lock) => base.releaseLock(lock),
    extendLock: (lock, ttlMs) => base.extendLock(lock, Math.max(ttlMs, MIN_LOCK_TTL_MS)),
    get: (key) => base.get(key),
    set: (key, value, ttlMs) => base.set(key, value, ttlMs),
    delete: (key) => base.delete(key)
  };
}

let _redisState: RedisStateAdapter | undefined;

function createStateAdapter() {
  if (!hasRedisConfig()) {
    throw new Error("REDIS_URL is required for durable Slack thread state");
  }

  _redisState = createRedisState({
    url: process.env.REDIS_URL
  });
  return createQueuedStateAdapter(_redisState);
}

let _stateAdapter: StateAdapter | undefined;

export function getStateAdapter(): StateAdapter {
  if (!_stateAdapter) {
    _stateAdapter = createStateAdapter();
  }
  return _stateAdapter;
}

export function getRedisClient(): ReturnType<RedisStateAdapter["getClient"]> {
  if (!_redisState) {
    getStateAdapter();
  }
  return _redisState!.getClient();
}
