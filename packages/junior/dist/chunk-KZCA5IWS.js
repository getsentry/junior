import {
  hasRedisConfig
} from "./chunk-OXUT4WDZ.js";

// src/chat/state.ts
import { createRedisState } from "@chat-adapter/state-redis";
var MIN_LOCK_TTL_MS = 1e3 * 60 * 5;
var WORKFLOW_INGRESS_DEDUP_PREFIX = "junior:workflow_ingress";
var WORKFLOW_STARTUP_LEASE_PREFIX = "junior:workflow_startup";
var WORKFLOW_MESSAGE_PROCESSING_PREFIX = "junior:workflow_message";
var WORKFLOW_MESSAGE_STARTED_TTL_MS = 2 * 60 * 60 * 1e3;
var WORKFLOW_MESSAGE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var WORKFLOW_MESSAGE_FAILED_TTL_MS = 6 * 60 * 60 * 1e3;
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
function workflowMessageKey(rawKey) {
  return `${WORKFLOW_MESSAGE_PROCESSING_PREFIX}:${rawKey}`;
}
function parseWorkflowMessageState(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || parsed.status !== "started" && parsed.status !== "completed" && parsed.status !== "failed" || typeof parsed.updatedAtMs !== "number") {
      return void 0;
    }
    return {
      status: parsed.status,
      updatedAtMs: parsed.updatedAtMs,
      ...typeof parsed.workflowRunId === "string" ? { workflowRunId: parsed.workflowRunId } : {},
      ...typeof parsed.errorMessage === "string" ? { errorMessage: parsed.errorMessage } : {}
    };
  } catch {
    return void 0;
  }
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
async function getWorkflowMessageProcessingState(rawKey) {
  await getStateAdapter().connect();
  const state = await getStateAdapter().get(workflowMessageKey(rawKey));
  return parseWorkflowMessageState(state);
}
async function markWorkflowMessageStarted(rawKey, workflowRunId) {
  await getStateAdapter().connect();
  const key = workflowMessageKey(rawKey);
  const payload = JSON.stringify({
    status: "started",
    updatedAtMs: Date.now(),
    ...workflowRunId ? { workflowRunId } : {}
  });
  const result = await getRedisStateAdapter().getClient().set(key, payload, {
    NX: true,
    PX: WORKFLOW_MESSAGE_STARTED_TTL_MS
  });
  return result === "OK";
}
async function markWorkflowMessageCompleted(rawKey, workflowRunId) {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "completed",
    updatedAtMs: Date.now(),
    ...workflowRunId ? { workflowRunId } : {}
  });
  await getStateAdapter().set(workflowMessageKey(rawKey), payload, WORKFLOW_MESSAGE_COMPLETED_TTL_MS);
}
async function markWorkflowMessageFailed(rawKey, errorMessage, workflowRunId) {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "failed",
    updatedAtMs: Date.now(),
    ...workflowRunId ? { workflowRunId } : {},
    errorMessage
  });
  await getStateAdapter().set(workflowMessageKey(rawKey), payload, WORKFLOW_MESSAGE_FAILED_TTL_MS);
}

export {
  getStateAdapter,
  claimWorkflowIngressDedup,
  claimWorkflowStartupLease,
  releaseWorkflowStartupLease,
  getWorkflowMessageProcessingState,
  markWorkflowMessageStarted,
  markWorkflowMessageCompleted,
  markWorkflowMessageFailed
};
