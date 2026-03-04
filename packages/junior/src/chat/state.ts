import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, StateAdapter } from "chat";
import { hasRedisConfig } from "@/chat/config";

const MIN_LOCK_TTL_MS = 1000 * 60 * 5;
const WORKFLOW_INGRESS_DEDUP_PREFIX = "junior:workflow_ingress";
const WORKFLOW_STARTUP_LEASE_PREFIX = "junior:workflow_startup";
const WORKFLOW_MESSAGE_PROCESSING_PREFIX = "junior:workflow_message";
const WORKFLOW_MESSAGE_PROCESSING_TTL_MS = 30 * 60 * 1000;
const WORKFLOW_MESSAGE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKFLOW_MESSAGE_FAILED_TTL_MS = 6 * 60 * 60 * 1000;
const COMPARE_AND_DELETE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
const CLAIM_OR_RECLAIM_PROCESSING_SCRIPT = `
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
const UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT = `
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

function createQueuedStateAdapter(base: StateAdapter): StateAdapter {
  const acquireLock = async (threadId: string, ttlMs: number): Promise<Lock | null> => {
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

export type WorkflowMessageProcessingStatus = "processing" | "started" | "completed" | "failed";

export interface WorkflowMessageProcessingState {
  status: WorkflowMessageProcessingStatus;
  updatedAtMs: number;
  startedAtMs?: number;
  ownerToken?: string;
  workflowRunId?: string;
  errorMessage?: string;
}

function workflowMessageKey(rawKey: string): string {
  return `${WORKFLOW_MESSAGE_PROCESSING_PREFIX}:${rawKey}`;
}

function parseWorkflowMessageState(value: unknown): WorkflowMessageProcessingState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<WorkflowMessageProcessingState>;
    if (
      !parsed ||
      (parsed.status !== "processing" &&
        parsed.status !== "started" &&
        parsed.status !== "completed" &&
        parsed.status !== "failed") ||
      typeof parsed.updatedAtMs !== "number"
    ) {
      return undefined;
    }
    return {
      status: parsed.status,
      updatedAtMs: parsed.updatedAtMs,
      ...(typeof parsed.startedAtMs === "number" ? { startedAtMs: parsed.startedAtMs } : {}),
      ...(typeof parsed.ownerToken === "string" ? { ownerToken: parsed.ownerToken } : {}),
      ...(typeof parsed.workflowRunId === "string" ? { workflowRunId: parsed.workflowRunId } : {}),
      ...(typeof parsed.errorMessage === "string" ? { errorMessage: parsed.errorMessage } : {})
    };
  } catch {
    return undefined;
  }
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

export async function hasWorkflowIngressDedup(rawKey: string): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${WORKFLOW_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const value = await getRedisStateAdapter().getClient().get(key);
  return typeof value === "string" && value.length > 0;
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

export async function getWorkflowMessageProcessingState(
  rawKey: string
): Promise<WorkflowMessageProcessingState | undefined> {
  await getStateAdapter().connect();
  const state = await getStateAdapter().get(workflowMessageKey(rawKey));
  return parseWorkflowMessageState(state);
}

export async function acquireWorkflowMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  workflowRunId?: string;
}): Promise<"acquired" | "reclaimed" | "blocked"> {
  await getStateAdapter().connect();
  const key = workflowMessageKey(args.rawKey);
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {})
  } satisfies WorkflowMessageProcessingState);
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

export async function refreshWorkflowMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  workflowRunId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {})
  } satisfies WorkflowMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_PROCESSING_TTL_MS), payload]
  });
  return result === 1;
}

export async function completeWorkflowMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  workflowRunId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "completed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {})
  } satisfies WorkflowMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_COMPLETED_TTL_MS), payload]
  });
  return result === 1;
}

export async function failWorkflowMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  errorMessage: string;
  workflowRunId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "failed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    errorMessage: args.errorMessage,
    ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {})
  } satisfies WorkflowMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [workflowMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(WORKFLOW_MESSAGE_FAILED_TTL_MS), payload]
  });
  return result === 1;
}

export async function markWorkflowMessageStarted(rawKey: string, workflowRunId?: string): Promise<boolean> {
  await getStateAdapter().connect();
  const claimResult = await acquireWorkflowMessageProcessingOwnership({
    rawKey,
    ownerToken: `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    workflowRunId
  });
  return claimResult !== "blocked";
}

export async function markWorkflowMessageCompleted(rawKey: string, workflowRunId?: string): Promise<void> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "completed",
    updatedAtMs: Date.now(),
    ...(workflowRunId ? { workflowRunId } : {})
  } satisfies WorkflowMessageProcessingState);
  await getStateAdapter().set(workflowMessageKey(rawKey), payload, WORKFLOW_MESSAGE_COMPLETED_TTL_MS);
}

export async function markWorkflowMessageFailed(
  rawKey: string,
  errorMessage: string,
  workflowRunId?: string
): Promise<void> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "failed",
    updatedAtMs: Date.now(),
    ...(workflowRunId ? { workflowRunId } : {}),
    errorMessage
  } satisfies WorkflowMessageProcessingState);
  await getStateAdapter().set(workflowMessageKey(rawKey), payload, WORKFLOW_MESSAGE_FAILED_TTL_MS);
}
