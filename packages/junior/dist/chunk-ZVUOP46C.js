// src/chat/state.ts
import { createRedisState } from "@chat-adapter/state-redis";

// src/chat/config.ts
function buildBotConfig() {
  return {
    userName: process.env.JUNIOR_BOT_NAME ?? "junior",
    modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
    fastModelId: process.env.AI_FAST_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-haiku-4-5"
  };
}
var botConfig = buildBotConfig();
function toOptionalTrimmed(value) {
  if (!value) {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function getSlackBotToken() {
  return toOptionalTrimmed(process.env.SLACK_BOT_TOKEN) ?? toOptionalTrimmed(process.env.SLACK_BOT_USER_TOKEN);
}
function getSlackSigningSecret() {
  return toOptionalTrimmed(process.env.SLACK_SIGNING_SECRET);
}
function getSlackClientId() {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_ID);
}
function getSlackClientSecret() {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_SECRET);
}
function hasRedisConfig() {
  return Boolean(process.env.REDIS_URL);
}

// src/chat/state.ts
var MIN_LOCK_TTL_MS = 1e3 * 60 * 5;
var WORKFLOW_INGRESS_DEDUP_PREFIX = "junior:workflow_ingress";
var WORKFLOW_STARTUP_LEASE_PREFIX = "junior:workflow_startup";
var WORKFLOW_MESSAGE_PROCESSING_PREFIX = "junior:workflow_message";
var WORKFLOW_MESSAGE_PROCESSING_TTL_MS = 30 * 60 * 1e3;
var WORKFLOW_MESSAGE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var WORKFLOW_MESSAGE_FAILED_TTL_MS = 6 * 60 * 60 * 1e3;
var COMPARE_AND_DELETE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
var CLAIM_OR_RECLAIM_PROCESSING_SCRIPT = `
  local key = KEYS[1]
  local nowMs = tonumber(ARGV[1])
  local ttlMs = tonumber(ARGV[2])
  local payload = ARGV[3]
  local current = redis.call("get", key)

  if not current then
    redis.call("set", key, payload, "PX", ttlMs)
    return 1
  end

  local ok, parsed = pcall(cjson.decode, current)
  if not ok or type(parsed) ~= "table" then
    return 0
  end

  local status = parsed["status"]
  if status ~= "processing" and status ~= "started" then
    return 0
  end

  local updatedAtMs = tonumber(parsed["updatedAtMs"])
  if not updatedAtMs then
    return 0
  end

  if updatedAtMs + ttlMs < nowMs then
    redis.call("set", key, payload, "PX", ttlMs)
    return 2
  end

  return 0
`;
var UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT = `
  local key = KEYS[1]
  local ownerToken = ARGV[1]
  local ttlMs = tonumber(ARGV[2])
  local payload = ARGV[3]
  local current = redis.call("get", key)

  if not current then
    return 0
  end

  local ok, parsed = pcall(cjson.decode, current)
  if not ok or type(parsed) ~= "table" then
    return 0
  end

  local currentOwner = parsed["ownerToken"]
  local status = parsed["status"]
  if currentOwner ~= ownerToken then
    return 0
  end
  if status ~= "processing" and status ~= "started" then
    return 0
  end

  redis.call("set", key, payload, "PX", ttlMs)
  return 1
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
    if (!parsed || parsed.status !== "processing" && parsed.status !== "started" && parsed.status !== "completed" && parsed.status !== "failed" || typeof parsed.updatedAtMs !== "number") {
      return void 0;
    }
    return {
      status: parsed.status,
      updatedAtMs: parsed.updatedAtMs,
      ...typeof parsed.startedAtMs === "number" ? { startedAtMs: parsed.startedAtMs } : {},
      ...typeof parsed.ownerToken === "string" ? { ownerToken: parsed.ownerToken } : {},
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
async function hasWorkflowIngressDedup(rawKey) {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const value = await getRedisStateAdapter().getClient().get(key);
  return typeof value === "string" && value.length > 0;
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
async function acquireWorkflowMessageProcessingOwnership(args) {
  await getStateAdapter().connect();
  const key = workflowMessageKey(args.rawKey);
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}
  });
  const result = await getRedisStateAdapter().getClient().eval(CLAIM_OR_RECLAIM_PROCESSING_SCRIPT, {
    keys: [key],
    arguments: [String(nowMs), String(WORKFLOW_MESSAGE_PROCESSING_TTL_MS), payload]
  });
  if (result === 1) {
    return "acquired";
  }
  if (result === 2) {
    return "reclaimed";
  }
  return "blocked";
}
async function refreshWorkflowMessageProcessingOwnership(args) {
  await getStateAdapter().connect();
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}
  });
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_PROCESSING_TTL_MS), payload]
  });
  return result === 1;
}
async function completeWorkflowMessageProcessingOwnership(args) {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "completed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    ...args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}
  });
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_COMPLETED_TTL_MS), payload]
  });
  return result === 1;
}
async function failWorkflowMessageProcessingOwnership(args) {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "failed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    errorMessage: args.errorMessage,
    ...args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}
  });
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_FAILED_TTL_MS), payload]
  });
  return result === 1;
}
async function markWorkflowMessageStarted(rawKey, workflowRunId) {
  await getStateAdapter().connect();
  const claimResult = await acquireWorkflowMessageProcessingOwnership({
    rawKey,
    ownerToken: `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    workflowRunId
  });
  return claimResult !== "blocked";
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
  botConfig,
  getSlackBotToken,
  getSlackSigningSecret,
  getSlackClientId,
  getSlackClientSecret,
  getStateAdapter,
  claimWorkflowIngressDedup,
  hasWorkflowIngressDedup,
  claimWorkflowStartupLease,
  releaseWorkflowStartupLease,
  getWorkflowMessageProcessingState,
  acquireWorkflowMessageProcessingOwnership,
  refreshWorkflowMessageProcessingOwnership,
  completeWorkflowMessageProcessingOwnership,
  failWorkflowMessageProcessingOwnership,
  markWorkflowMessageStarted,
  markWorkflowMessageCompleted,
  markWorkflowMessageFailed
};
