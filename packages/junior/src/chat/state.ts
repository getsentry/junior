import { createRedisState } from "@chat-adapter/state-redis";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { Lock, StateAdapter } from "chat";
import { hasRedisConfig } from "@/chat/config";

const MIN_LOCK_TTL_MS = 1000 * 60 * 5;
const QUEUE_INGRESS_DEDUP_PREFIX = "junior:queue_ingress";
const QUEUE_MESSAGE_PROCESSING_PREFIX = "junior:queue_message";
const QUEUE_MESSAGE_PROCESSING_TTL_MS = 30 * 60 * 1000;
const QUEUE_MESSAGE_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUEUE_MESSAGE_FAILED_TTL_MS = 6 * 60 * 60 * 1000;
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
  if status == "failed" then
    redis.call("set", key, payload, "PX", ttlMs)
    return 3
  end
  if status ~= "processing" then
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
  if status ~= "processing" then
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
    throw new Error("Redis state adapter is unavailable for queue ingress dedupe");
  }

  return _redisStateAdapter;
}

export type QueueMessageProcessingStatus = "processing" | "completed" | "failed";

export interface QueueMessageProcessingState {
  status: QueueMessageProcessingStatus;
  updatedAtMs: number;
  ownerToken?: string;
  queueMessageId?: string;
  errorMessage?: string;
}

function queueMessageKey(rawKey: string): string {
  return `${QUEUE_MESSAGE_PROCESSING_PREFIX}:${rawKey}`;
}

function parseQueueMessageState(value: unknown): QueueMessageProcessingState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<QueueMessageProcessingState>;
    if (
      !parsed ||
      (parsed.status !== "processing" && parsed.status !== "completed" && parsed.status !== "failed") ||
      typeof parsed.updatedAtMs !== "number"
    ) {
      return undefined;
    }
    return {
      status: parsed.status,
      updatedAtMs: parsed.updatedAtMs,
      ...(typeof parsed.ownerToken === "string" ? { ownerToken: parsed.ownerToken } : {}),
      ...(typeof parsed.queueMessageId === "string" ? { queueMessageId: parsed.queueMessageId } : {}),
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

export async function claimQueueIngressDedup(rawKey: string, ttlMs: number): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${QUEUE_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const result = await getRedisStateAdapter().getClient().set(key, "1", {
    NX: true,
    PX: ttlMs
  });
  return result === "OK";
}

export async function hasQueueIngressDedup(rawKey: string): Promise<boolean> {
  await getStateAdapter().connect();
  const key = `${QUEUE_INGRESS_DEDUP_PREFIX}:${rawKey}`;
  const value = await getRedisStateAdapter().getClient().get(key);
  return typeof value === "string" && value.length > 0;
}

export async function getQueueMessageProcessingState(
  rawKey: string
): Promise<QueueMessageProcessingState | undefined> {
  await getStateAdapter().connect();
  const state = await getStateAdapter().get(queueMessageKey(rawKey));
  return parseQueueMessageState(state);
}

export async function acquireQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<"acquired" | "reclaimed" | "recovered" | "blocked"> {
  await getStateAdapter().connect();
  const key = queueMessageKey(args.rawKey);
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...(args.queueMessageId ? { queueMessageId: args.queueMessageId } : {})
  } satisfies QueueMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(CLAIM_OR_RECLAIM_PROCESSING_SCRIPT, {
    keys: [key],
    arguments: [String(nowMs), String(QUEUE_MESSAGE_PROCESSING_TTL_MS), payload]
  });
  if (result === 1) {
    return "acquired";
  }
  if (result === 2) {
    return "reclaimed";
  }
  if (result === 3) {
    return "recovered";
  }
  return "blocked";
}

export async function refreshQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const nowMs = Date.now();
  const payload = JSON.stringify({
    status: "processing",
    updatedAtMs: nowMs,
    ownerToken: args.ownerToken,
    ...(args.queueMessageId ? { queueMessageId: args.queueMessageId } : {})
  } satisfies QueueMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [queueMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(QUEUE_MESSAGE_PROCESSING_TTL_MS), payload]
  });
  return result === 1;
}

export async function completeQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "completed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    ...(args.queueMessageId ? { queueMessageId: args.queueMessageId } : {})
  } satisfies QueueMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [queueMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(QUEUE_MESSAGE_COMPLETED_TTL_MS), payload]
  });
  return result === 1;
}

export async function failQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  errorMessage: string;
  queueMessageId?: string;
}): Promise<boolean> {
  await getStateAdapter().connect();
  const payload = JSON.stringify({
    status: "failed",
    updatedAtMs: Date.now(),
    ownerToken: args.ownerToken,
    errorMessage: args.errorMessage,
    ...(args.queueMessageId ? { queueMessageId: args.queueMessageId } : {})
  } satisfies QueueMessageProcessingState);
  const result = await getRedisStateAdapter().getClient().eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
    keys: [queueMessageKey(args.rawKey)],
    arguments: [args.ownerToken, String(QUEUE_MESSAGE_FAILED_TTL_MS), payload]
  });
  return result === 1;
}
