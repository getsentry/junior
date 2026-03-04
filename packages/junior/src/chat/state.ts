import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, StateAdapter } from "chat";
import { hasRedisConfig } from "@/chat/config";
import { logInfo } from "@/chat/observability";

const MIN_LOCK_TTL_MS = 1000 * 60 * 5;
const WORKFLOW_INGRESS_DEDUP_PREFIX = "junior:workflow_ingress";
const WORKFLOW_STARTUP_LEASE_PREFIX = "junior:workflow_startup";
const COMPARE_AND_DELETE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

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

function createStateAdapter() {
  if (!hasRedisConfig()) {
    throw new Error("REDIS_URL is required for durable Slack thread state");
  }

  const redisState = createRedisState({
    url: process.env.REDIS_URL
  });
  _redisStateAdapter = redisState;
  return createQueuedStateAdapter(redisState);
}

let _stateAdapter: StateAdapter | undefined;
let _redisStateAdapter: RedisStateAdapter | undefined;

function getRedisStateAdapter(): RedisStateAdapter {
  if (!_redisStateAdapter) {
    getStateAdapter();
  }

  if (!_redisStateAdapter) {
    throw new Error("Redis state adapter is unavailable for workflow ingress dedupe");
  }

  return _redisStateAdapter;
}

export function getStateAdapter(): StateAdapter {
  if (!_stateAdapter) {
    _stateAdapter = createStateAdapter();
  }
  return _stateAdapter;
}

export async function claimWorkflowIngressDedup(rawKey: string, ttlMs: number): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const result = await getRedisStateAdapter().getClient().set(key, "1", {
    NX: true,
    PX: ttlMs
  });
  return result === "OK";
}

export async function claimWorkflowStartupLease(
  normalizedThreadId: string,
  ownerToken: string,
  ttlMs: number
): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_STARTUP_LEASE_PREFIX}:${normalizedThreadId}`;
  const result = await getRedisStateAdapter().getClient().set(key, ownerToken, {
    NX: true,
    PX: ttlMs
  });
  return result === "OK";
}

export async function releaseWorkflowStartupLease(
  normalizedThreadId: string,
  ownerToken: string
): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_STARTUP_LEASE_PREFIX}:${normalizedThreadId}`;
  const result = await getRedisStateAdapter().getClient().eval(COMPARE_AND_DELETE_SCRIPT, {
    keys: [key],
    arguments: [ownerToken]
  });
  return result === 1;
}
