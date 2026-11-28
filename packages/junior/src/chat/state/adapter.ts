import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import { getAppContext } from "@/app/context";
import { getChatConfig, type ChatConfig } from "@/chat/config";
import { mapBounded } from "@/chat/fan-out";
import { ACTIVE_LOCK_TTL_MS } from "@/chat/state/locks";

const ACTIVE_LOCK_HEARTBEAT_MS = 30_000;
// The Redis adapter keeps `get` and `set` values as JSON under
// `{prefix}:cache:{key}`. The batch reads and writes below use the same keys.
const REDIS_STATE_KEY_PREFIX = "chat-sdk";

/**
 * Open the base adapter on first use and connect before each operation,
 * including queued-adapter lock heartbeats. After `drop`, the next use opens
 * a new base.
 */
function createConnectingStateAdapter(
  open: () => StateAdapter,
): StateAdapter & { drop(): void } {
  let current: StateAdapter | undefined;
  const base = (): StateAdapter => (current ??= open());
  const connected = async <T>(
    operation: (adapter: StateAdapter) => Promise<T>,
  ): Promise<T> => {
    const adapter = base();
    await adapter.connect();
    return await operation(adapter);
  };

  return {
    appendToList: (key, value, options) =>
      connected((adapter) => adapter.appendToList(key, value, options)),
    connect: () => base().connect(),
    disconnect: async () => await current?.disconnect(),
    drop: () => {
      current = undefined;
    },
    subscribe: (threadId) =>
      connected((adapter) => adapter.subscribe(threadId)),
    unsubscribe: (threadId) =>
      connected((adapter) => adapter.unsubscribe(threadId)),
    isSubscribed: (threadId) =>
      connected((adapter) => adapter.isSubscribed(threadId)),
    acquireLock: (threadId, ttlMs) =>
      connected((adapter) => adapter.acquireLock(threadId, ttlMs)),
    releaseLock: (lock) => connected((adapter) => adapter.releaseLock(lock)),
    extendLock: (lock, ttlMs) =>
      connected((adapter) => adapter.extendLock(lock, ttlMs)),
    forceReleaseLock: (threadId) =>
      connected((adapter) => adapter.forceReleaseLock(threadId)),
    enqueue: (threadId, entry, maxSize) =>
      connected((adapter) => adapter.enqueue(threadId, entry, maxSize)),
    dequeue: (threadId) => connected((adapter) => adapter.dequeue(threadId)),
    queueDepth: (threadId) =>
      connected((adapter) => adapter.queueDepth(threadId)),
    get: (key) => connected((adapter) => adapter.get(key)),
    getList: (key) => connected((adapter) => adapter.getList(key)),
    set: (key, value, ttlMs) =>
      connected((adapter) => adapter.set(key, value, ttlMs)),
    setIfNotExists: (key, value, ttlMs) =>
      connected((adapter) => adapter.setIfNotExists(key, value, ttlMs)),
    delete: (key) => connected((adapter) => adapter.delete(key)),
  };
}

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

  // StateAdapter only carries a TTL through acquire/extend calls, so the
  // active-lock TTL is the explicit opt-in for adapter-owned heartbeats.
  const shouldHeartbeatLock = (ttlMs: number): boolean =>
    ttlMs === ACTIVE_LOCK_TTL_MS;

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
    const lock = await base.acquireLock(threadId, ttlMs);
    if (lock && shouldHeartbeatLock(ttlMs)) {
      startOrUpdateHeartbeat(lock, ttlMs);
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
      const extended = await base.extendLock(lock, ttlMs);
      if (extended) {
        lock.expiresAt = Date.now() + ttlMs;
        if (shouldHeartbeatLock(ttlMs)) {
          startOrUpdateHeartbeat(lock, ttlMs);
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

/** The state adapter of an app context. */
export interface AppState extends StateAdapter {
  /** The Redis adapter under this state, when config selects Redis. */
  redis(): RedisStateAdapter | undefined;
  /** Disconnect and drop the adapter. The next use opens a new one. */
  close(): Promise<void>;
}

/**
 * Build the state adapter that config selects. It connects on first use.
 * After `close`, the next use opens a new adapter: an empty memory store or a
 * new Redis client.
 */
export function createAppState(
  config: Pick<ChatConfig, "bot" | "state">,
): AppState {
  const activeLockMaxAgeMs = config.bot.turnTimeoutMs + ACTIVE_LOCK_TTL_MS;
  let redis: RedisStateAdapter | undefined;
  const open = (): StateAdapter => {
    if (config.state.adapter === "memory") {
      redis = undefined;
      return withOptionalPrefix(createMemoryState(), config.state.keyPrefix);
    }
    if (!config.state.redisUrl) {
      throw new Error("REDIS_URL is required for durable Slack thread state");
    }
    redis = createRedisState({
      keyPrefix: REDIS_STATE_KEY_PREFIX,
      url: config.state.redisUrl,
    });
    return withOptionalPrefix(redis, config.state.keyPrefix);
  };
  const connecting = createConnectingStateAdapter(open);
  const queued = createQueuedStateAdapter(connecting, { activeLockMaxAgeMs });
  return {
    ...queued,
    redis: () => redis,
    close: async () => {
      await queued.disconnect();
      connecting.drop();
    },
  };
}

export async function getConnectedStateContext(): Promise<{
  redisStateAdapter?: RedisStateAdapter | undefined;
  stateAdapter: StateAdapter;
}> {
  const adapter = getStateAdapter();
  await adapter.connect();
  return {
    redisStateAdapter: adapter.redis(),
    stateAdapter: adapter,
  };
}

/** Return the Redis adapter only when the caller is using the default state adapter. */
export async function getDefaultRedisStateAdapterFor(
  adapter: StateAdapter,
): Promise<RedisStateAdapter | undefined> {
  if (adapter !== getStateAdapter()) {
    return undefined;
  }
  const context = await getConnectedStateContext();
  return context.redisStateAdapter;
}

/** The Redis key that the default Redis adapter uses for one state value key. */
export function redisStateKey(key: string): string {
  const prefix = getChatConfig().state.keyPrefix;
  return `${REDIS_STATE_KEY_PREFIX}:cache:${prefix ? `${prefix}:` : ""}${key}`;
}

/** Read state values in one Redis round trip. Other adapters read each key. */
export async function getStateValues(
  state: StateAdapter,
  keys: readonly string[],
): Promise<unknown[]> {
  if (keys.length === 0) return [];
  const redis = await getDefaultRedisStateAdapterFor(state);
  if (!redis) {
    return await mapBounded(keys, (key) => state.get(key));
  }
  const values = await redis.getClient().mGet(keys.map(redisStateKey));
  return values.map((value) => {
    if (value === null) return null;
    // Match `RedisStateAdapter.get`, which returns a value that is not JSON as is.
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  });
}

/** Write state values with one TTL in one Redis round trip. */
export async function setStateValues(
  state: StateAdapter,
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  ttlMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const redis = await getDefaultRedisStateAdapterFor(state);
  if (!redis) {
    await mapBounded(entries, ({ key, value }) => state.set(key, value, ttlMs));
    return;
  }
  const pipeline = redis.getClient().multi();
  for (const { key, value } of entries) {
    pipeline.set(redisStateKey(key), JSON.stringify(value), { PX: ttlMs });
  }
  await pipeline.execAsPipeline();
}

/** Return the state adapter of the app context. */
export function getStateAdapter(): AppState {
  return getAppContext().state;
}

/** Close the app state. The next use opens a new adapter. */
export async function disconnectStateAdapter(): Promise<void> {
  await getStateAdapter().close();
}
