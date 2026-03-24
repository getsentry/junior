import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";

const MIN_LOCK_TTL_MS = 1000 * 60 * 5;

let stateAdapter: StateAdapter | undefined;
let redisStateAdapter: RedisStateAdapter | undefined;

function createQueuedStateAdapter(base: StateAdapter): StateAdapter {
  const acquireLock = async (
    threadId: string,
    ttlMs: number,
  ): Promise<Lock | null> => {
    const effectiveTtlMs = Math.max(ttlMs, MIN_LOCK_TTL_MS);
    return await base.acquireLock(threadId, effectiveTtlMs);
  };

  return {
    appendToList: (key, value, options) =>
      base.appendToList(key, value, options),
    connect: () => base.connect(),
    disconnect: () => base.disconnect(),
    subscribe: (threadId) => base.subscribe(threadId),
    unsubscribe: (threadId) => base.unsubscribe(threadId),
    isSubscribed: (threadId) => base.isSubscribed(threadId),
    acquireLock,
    releaseLock: (lock) => base.releaseLock(lock),
    extendLock: (lock, ttlMs) =>
      base.extendLock(lock, Math.max(ttlMs, MIN_LOCK_TTL_MS)),
    forceReleaseLock: (threadId) => base.forceReleaseLock(threadId),
    get: (key) => base.get(key),
    getList: (key) => base.getList(key),
    set: (key, value, ttlMs) => base.set(key, value, ttlMs),
    setIfNotExists: (key, value, ttlMs) =>
      base.setIfNotExists(key, value, ttlMs),
    delete: (key) => base.delete(key),
  };
}

function createStateAdapter(): StateAdapter {
  const config = getChatConfig();

  if (config.state.adapter === "memory") {
    redisStateAdapter = undefined;
    return createQueuedStateAdapter(createMemoryState());
  }

  if (!config.state.redisUrl) {
    throw new Error("REDIS_URL is required for durable Slack thread state");
  }

  const redisState = createRedisState({
    url: config.state.redisUrl,
  });
  redisStateAdapter = redisState;
  return createQueuedStateAdapter(redisState);
}

function getOptionalRedisStateAdapter(): RedisStateAdapter | undefined {
  getStateAdapter();
  return redisStateAdapter;
}

export async function getConnectedStateContext(): Promise<{
  redisStateAdapter?: RedisStateAdapter;
  stateAdapter: StateAdapter;
}> {
  const adapter = getStateAdapter();
  await adapter.connect();
  return {
    redisStateAdapter: getOptionalRedisStateAdapter(),
    stateAdapter: adapter,
  };
}

export function getStateAdapter(): StateAdapter {
  if (!stateAdapter) {
    stateAdapter = createStateAdapter();
  }
  return stateAdapter;
}

export async function disconnectStateAdapter(): Promise<void> {
  if (!stateAdapter) {
    return;
  }

  try {
    await stateAdapter.disconnect();
  } finally {
    stateAdapter = undefined;
    redisStateAdapter = undefined;
  }
}
