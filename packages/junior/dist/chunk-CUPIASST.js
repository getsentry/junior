import {
  hasRedisConfig
} from "./chunk-OXUT4WDZ.js";
import {
  logInfo
} from "./chunk-OXCKLXL3.js";

// src/chat/state.ts
import { createRedisState } from "@chat-adapter/state-redis";
var MIN_LOCK_TTL_MS = 1e3 * 60 * 5;
var WORKFLOW_INGRESS_DEDUP_PREFIX = "junior:workflow_ingress";
var WORKFLOW_STARTUP_LEASE_PREFIX = "junior:workflow_startup";
var COMPARE_AND_DELETE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
function createQueuedStateAdapter(base) {
  const acquireLock = async (threadId, ttlMs) => {
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
var _stateAdapter;
var _redisStateAdapter;
function getRedisStateAdapter() {
  if (!_redisStateAdapter) {
    getStateAdapter();
  }
  if (!_redisStateAdapter) {
    throw new Error("Redis state adapter is unavailable for workflow ingress dedupe");
  }
  return _redisStateAdapter;
}
function getStateAdapter() {
  if (!_stateAdapter) {
    _stateAdapter = createStateAdapter();
  }
  return _stateAdapter;
}
async function claimWorkflowIngressDedup(rawKey, ttlMs) {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const result = await getRedisStateAdapter().getClient().set(key, "1", {
    NX: true,
    PX: ttlMs
  });
  return result === "OK";
}
async function claimWorkflowStartupLease(normalizedThreadId, ownerToken, ttlMs) {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_STARTUP_LEASE_PREFIX}:${normalizedThreadId}`;
  const result = await getRedisStateAdapter().getClient().set(key, ownerToken, {
    NX: true,
    PX: ttlMs
  });
  return result === "OK";
}
async function releaseWorkflowStartupLease(normalizedThreadId, ownerToken) {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_STARTUP_LEASE_PREFIX}:${normalizedThreadId}`;
  const result = await getRedisStateAdapter().getClient().eval(COMPARE_AND_DELETE_SCRIPT, {
    keys: [key],
    arguments: [ownerToken]
  });
  return result === 1;
}

export {
  getStateAdapter,
  claimWorkflowIngressDedup,
  claimWorkflowStartupLease,
  releaseWorkflowStartupLease
};
