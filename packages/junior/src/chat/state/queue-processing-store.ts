import type { StateAdapter } from "chat";
import { getConnectedStateContext, getStateAdapter } from "./adapter";

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

export type QueueMessageProcessingStatus =
  | "processing"
  | "completed"
  | "failed";

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

function buildQueueMessageProcessingPayload(args: {
  errorMessage?: string;
  ownerToken: string;
  queueMessageId?: string;
  status: QueueMessageProcessingStatus;
  updatedAtMs?: number;
}): string {
  return JSON.stringify({
    status: args.status,
    updatedAtMs: args.updatedAtMs ?? Date.now(),
    ownerToken: args.ownerToken,
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(args.queueMessageId ? { queueMessageId: args.queueMessageId } : {}),
  } satisfies QueueMessageProcessingState);
}

function parseQueueMessageState(
  value: unknown,
): QueueMessageProcessingState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<QueueMessageProcessingState>;
    if (
      !parsed ||
      (parsed.status !== "processing" &&
        parsed.status !== "completed" &&
        parsed.status !== "failed") ||
      typeof parsed.updatedAtMs !== "number"
    ) {
      return undefined;
    }
    return {
      status: parsed.status,
      updatedAtMs: parsed.updatedAtMs,
      ...(typeof parsed.ownerToken === "string"
        ? { ownerToken: parsed.ownerToken }
        : {}),
      ...(typeof parsed.queueMessageId === "string"
        ? { queueMessageId: parsed.queueMessageId }
        : {}),
      ...(typeof parsed.errorMessage === "string"
        ? { errorMessage: parsed.errorMessage }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function updateQueueMessageProcessingStateIfOwner(args: {
  rawKey: string;
  ownerToken: string;
  payload: string;
  ttlMs: number;
  stateAdapter: StateAdapter;
}): Promise<boolean> {
  const existingState = parseQueueMessageState(
    await args.stateAdapter.get(queueMessageKey(args.rawKey)),
  );
  if (
    !existingState ||
    existingState.status !== "processing" ||
    existingState.ownerToken !== args.ownerToken
  ) {
    return false;
  }
  await args.stateAdapter.set(
    queueMessageKey(args.rawKey),
    args.payload,
    args.ttlMs,
  );
  return true;
}

export async function getQueueMessageProcessingState(
  rawKey: string,
): Promise<QueueMessageProcessingState | undefined> {
  const adapter = getStateAdapter();
  await adapter.connect();
  const state = await adapter.get(queueMessageKey(rawKey));
  return parseQueueMessageState(state);
}

export async function acquireQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<"acquired" | "reclaimed" | "recovered" | "blocked"> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const key = queueMessageKey(args.rawKey);
  const nowMs = Date.now();
  const payload = buildQueueMessageProcessingPayload({
    ownerToken: args.ownerToken,
    queueMessageId: args.queueMessageId,
    status: "processing",
    updatedAtMs: nowMs,
  });
  if (redisStateAdapter) {
    const result = await redisStateAdapter
      .getClient()
      .eval(CLAIM_OR_RECLAIM_PROCESSING_SCRIPT, {
        keys: [key],
        arguments: [
          String(nowMs),
          String(QUEUE_MESSAGE_PROCESSING_TTL_MS),
          payload,
        ],
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

  const existingState = parseQueueMessageState(await stateAdapter.get(key));
  if (!existingState) {
    const claimed = await stateAdapter.setIfNotExists(
      key,
      payload,
      QUEUE_MESSAGE_PROCESSING_TTL_MS,
    );
    return claimed ? "acquired" : "blocked";
  }
  if (existingState.status === "failed") {
    await stateAdapter.set(key, payload, QUEUE_MESSAGE_PROCESSING_TTL_MS);
    return "recovered";
  }
  if (
    existingState.status === "processing" &&
    existingState.updatedAtMs + QUEUE_MESSAGE_PROCESSING_TTL_MS < nowMs
  ) {
    await stateAdapter.set(key, payload, QUEUE_MESSAGE_PROCESSING_TTL_MS);
    return "reclaimed";
  }
  return "blocked";
}

export async function refreshQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<boolean> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const payload = buildQueueMessageProcessingPayload({
    ownerToken: args.ownerToken,
    queueMessageId: args.queueMessageId,
    status: "processing",
  });
  if (redisStateAdapter) {
    const result = await redisStateAdapter
      .getClient()
      .eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
        keys: [queueMessageKey(args.rawKey)],
        arguments: [
          args.ownerToken,
          String(QUEUE_MESSAGE_PROCESSING_TTL_MS),
          payload,
        ],
      });
    return result === 1;
  }
  return await updateQueueMessageProcessingStateIfOwner({
    rawKey: args.rawKey,
    ownerToken: args.ownerToken,
    payload,
    ttlMs: QUEUE_MESSAGE_PROCESSING_TTL_MS,
    stateAdapter,
  });
}

export async function completeQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  queueMessageId?: string;
}): Promise<boolean> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const payload = buildQueueMessageProcessingPayload({
    ownerToken: args.ownerToken,
    queueMessageId: args.queueMessageId,
    status: "completed",
  });
  if (redisStateAdapter) {
    const result = await redisStateAdapter
      .getClient()
      .eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
        keys: [queueMessageKey(args.rawKey)],
        arguments: [
          args.ownerToken,
          String(QUEUE_MESSAGE_COMPLETED_TTL_MS),
          payload,
        ],
      });
    return result === 1;
  }
  return await updateQueueMessageProcessingStateIfOwner({
    rawKey: args.rawKey,
    ownerToken: args.ownerToken,
    payload,
    ttlMs: QUEUE_MESSAGE_COMPLETED_TTL_MS,
    stateAdapter,
  });
}

export async function failQueueMessageProcessingOwnership(args: {
  rawKey: string;
  ownerToken: string;
  errorMessage: string;
  queueMessageId?: string;
}): Promise<boolean> {
  const { stateAdapter, redisStateAdapter } = await getConnectedStateContext();
  const payload = buildQueueMessageProcessingPayload({
    errorMessage: args.errorMessage,
    ownerToken: args.ownerToken,
    queueMessageId: args.queueMessageId,
    status: "failed",
  });
  if (redisStateAdapter) {
    const result = await redisStateAdapter
      .getClient()
      .eval(UPDATE_PROCESSING_STATE_IF_OWNER_SCRIPT, {
        keys: [queueMessageKey(args.rawKey)],
        arguments: [
          args.ownerToken,
          String(QUEUE_MESSAGE_FAILED_TTL_MS),
          payload,
        ],
      });
    return result === 1;
  }
  return await updateQueueMessageProcessingStateIfOwner({
    rawKey: args.rawKey,
    ownerToken: args.ownerToken,
    payload,
    ttlMs: QUEUE_MESSAGE_FAILED_TTL_MS,
    stateAdapter,
  });
}
