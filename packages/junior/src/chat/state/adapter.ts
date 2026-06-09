import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";

export const ACTIVE_LOCK_TTL_MS = 90_000;
const ACTIVE_LOCK_HEARTBEAT_MS = 30_000;

let stateAdapter: StateAdapter | undefined;
let redisStateAdapter: RedisStateAdapter | undefined;

function createPrefixedStateAdapter(
  base: StateAdapter,
  prefix: string,
): StateAdapter {
  const prefixed = (value: string): string => `${prefix}:${value}`;
  const unprefixed = (value: string): string =>
    value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : value;
  const prefixLock = (lock: Lock): Lock => ({
    ...lock,
    threadId: prefixed(lock.threadId),
  });
  const unprefixLock = (lock: Lock): Lock => ({
    ...lock,
    threadId: unprefixed(lock.threadId),
  });

  return {
    appendToList: (key, value, options) =>
      base.appendToList(prefixed(key), value, options),
    connect: () => base.connect(),
    disconnect: () => base.disconnect(),
    subscribe: (threadId) => base.subscribe(prefixed(threadId)),
    unsubscribe: (threadId) => base.unsubscribe(prefixed(threadId)),
    isSubscribed: (threadId) => base.isSubscribed(prefixed(threadId)),
    acquireLock: async (threadId, ttlMs) => {
      const lock = await base.acquireLock(prefixed(threadId), ttlMs);
      return lock ? unprefixLock(lock) : null;
    },
    releaseLock: (lock) => base.releaseLock(prefixLock(lock)),
    extendLock: async (lock, ttlMs) => {
      const prefixedLock = prefixLock(lock);
      const extended = await base.extendLock(prefixedLock, ttlMs);
      if (extended) {
        lock.expiresAt = prefixedLock.expiresAt;
      }
      return extended;
    },
    forceReleaseLock: (threadId) => base.forceReleaseLock(prefixed(threadId)),
    enqueue: (threadId, entry, maxSize) =>
      base.enqueue(prefixed(threadId), entry, maxSize),
    dequeue: (threadId) => base.dequeue(prefixed(threadId)),
    queueDepth: (threadId) => base.queueDepth(prefixed(threadId)),
    get: (key) => base.get(prefixed(key)),
    getList: (key) => base.getList(prefixed(key)),
    set: (key, value, ttlMs) => base.set(prefixed(key), value, ttlMs),
    setIfNotExists: (key, value, ttlMs) =>
      base.setIfNotExists(prefixed(key), value, ttlMs),
    delete: (key) => base.delete(prefixed(key)),
  };
}

function createQueuedStateAdapter(
  base: StateAdapter,
  options: { activeLockMaxAgeMs: number },
): StateAdapter {
  type LockHeartbeat = {
    inFlight: boolean;
    lock: Lock;
    startedAtMs: number;
    timer: ReturnType<typeof setInterval>;
    ttlMs: number;
  };

  const heartbeats = new Map<string, LockHeartbeat>();

  const effectiveLockTtlMs = (ttlMs: number): number =>
    Math.max(ttlMs, ACTIVE_LOCK_TTL_MS);

  const shouldHeartbeatLock = (ttlMs: number): boolean =>
    ttlMs <= ACTIVE_LOCK_TTL_MS;

  const heartbeatKey = (lock: Lock): string => `${lock.threadId}:${lock.token}`;

  const stopHeartbeatByKey = (key: string): void => {
    const heartbeat = heartbeats.get(key);
    if (!heartbeat) {
      return;
    }
    clearInterval(heartbeat.timer);
    heartbeats.delete(key);
  };

  const stopHeartbeat = (lock: Lock): void => {
    stopHeartbeatByKey(heartbeatKey(lock));
  };

  const stopHeartbeatsForThread = (threadId: string): void => {
    for (const [key, heartbeat] of heartbeats) {
      if (heartbeat.lock.threadId === threadId) {
        stopHeartbeatByKey(key);
      }
    }
  };

  const stopAllHeartbeats = (): void => {
    for (const key of heartbeats.keys()) {
      stopHeartbeatByKey(key);
    }
  };

  const runHeartbeat = async (key: string): Promise<void> => {
    const heartbeat = heartbeats.get(key);
    if (!heartbeat || heartbeat.inFlight) {
      return;
    }

    heartbeat.inFlight = true;
    try {
      if (Date.now() - heartbeat.startedAtMs >= options.activeLockMaxAgeMs) {
        stopHeartbeatByKey(key);
        return;
      }
      const extended = await base.extendLock(heartbeat.lock, heartbeat.ttlMs);
      if (!extended) {
        stopHeartbeatByKey(key);
        return;
      }
      heartbeat.lock.expiresAt = Date.now() + heartbeat.ttlMs;
    } catch {
      // Keep the heartbeat alive; a later tick can recover after transient
      // adapter failures while the existing lease is still valid.
    } finally {
      const current = heartbeats.get(key);
      if (current === heartbeat) {
        current.inFlight = false;
      }
    }
  };

  const startOrUpdateHeartbeat = (lock: Lock, ttlMs: number): void => {
    const key = heartbeatKey(lock);
    const existing = heartbeats.get(key);
    if (existing) {
      existing.ttlMs = ttlMs;
      return;
    }

    const timer = setInterval(() => {
      void runHeartbeat(key);
    }, ACTIVE_LOCK_HEARTBEAT_MS);
    (timer as { unref?: () => void }).unref?.();
    heartbeats.set(key, {
      inFlight: false,
      lock,
      startedAtMs: Date.now(),
      timer,
      ttlMs,
    });
  };

  const acquireLock = async (
    threadId: string,
    ttlMs: number,
  ): Promise<Lock | null> => {
    const effectiveTtlMs = effectiveLockTtlMs(ttlMs);
    const lock = await base.acquireLock(threadId, effectiveTtlMs);
    if (lock && shouldHeartbeatLock(ttlMs)) {
      startOrUpdateHeartbeat(lock, effectiveTtlMs);
    }
    return lock;
  };

  return {
    appendToList: (key, value, options) =>
      base.appendToList(key, value, options),
    connect: () => base.connect(),
    disconnect: async () => {
      stopAllHeartbeats();
      await base.disconnect();
    },
    subscribe: (threadId) => base.subscribe(threadId),
    unsubscribe: (threadId) => base.unsubscribe(threadId),
    isSubscribed: (threadId) => base.isSubscribed(threadId),
    acquireLock,
    releaseLock: async (lock) => {
      stopHeartbeat(lock);
      await base.releaseLock(lock);
    },
    extendLock: async (lock, ttlMs) => {
      const effectiveTtlMs = effectiveLockTtlMs(ttlMs);
      const extended = await base.extendLock(lock, effectiveTtlMs);
      if (extended) {
        lock.expiresAt = Date.now() + effectiveTtlMs;
        if (shouldHeartbeatLock(ttlMs)) {
          startOrUpdateHeartbeat(lock, effectiveTtlMs);
        } else {
          stopHeartbeat(lock);
        }
      } else {
        stopHeartbeat(lock);
      }
      return extended;
    },
    forceReleaseLock: async (threadId) => {
      stopHeartbeatsForThread(threadId);
      await base.forceReleaseLock(threadId);
    },
    enqueue: (threadId: string, entry: QueueEntry, maxSize: number) =>
      base.enqueue(threadId, entry, maxSize),
    dequeue: (threadId: string) => base.dequeue(threadId),
    queueDepth: (threadId: string) => base.queueDepth(threadId),
    get: (key) => base.get(key),
    getList: (key) => base.getList(key),
    set: (key, value, ttlMs) => base.set(key, value, ttlMs),
    setIfNotExists: (key, value, ttlMs) =>
      base.setIfNotExists(key, value, ttlMs),
    delete: (key) => base.delete(key),
  };
}

function withOptionalPrefix(base: StateAdapter, prefix: string | undefined) {
  return prefix ? createPrefixedStateAdapter(base, prefix) : base;
}

function createStateAdapter(): StateAdapter {
  const config = getChatConfig();
  const activeLockMaxAgeMs = config.bot.turnTimeoutMs + ACTIVE_LOCK_TTL_MS;

  if (config.state.adapter === "memory") {
    redisStateAdapter = undefined;
    return createQueuedStateAdapter(
      withOptionalPrefix(createMemoryState(), config.state.keyPrefix),
      { activeLockMaxAgeMs },
    );
  }

  if (!config.state.redisUrl) {
    throw new Error("REDIS_URL is required for durable Slack thread state");
  }

  const redisState = createRedisState({
    url: config.state.redisUrl,
  });
  redisStateAdapter = redisState;
  return createQueuedStateAdapter(
    withOptionalPrefix(redisState, config.state.keyPrefix),
    { activeLockMaxAgeMs },
  );
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

/** Return the Redis adapter only when the caller is using the default state adapter. */
export async function getDefaultRedisStateAdapterFor(
  adapter: StateAdapter,
): Promise<RedisStateAdapter | undefined> {
  if (adapter !== stateAdapter) {
    return undefined;
  }
  const context = await getConnectedStateContext();
  return context.stateAdapter === adapter
    ? context.redisStateAdapter
    : undefined;
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
