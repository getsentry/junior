import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
import { getChatConfig } from "@/chat/config";
import { parseDestination, sameDestination } from "@/chat/destination";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import {
  getConversation,
  requestConversationWork,
  type Conversation,
  type ExecutionStatus,
  type InboundMessage,
  type Lease,
  type Source,
} from "@/chat/task-execution/store";
import type {
  MigrationContext,
  MigrationResult,
  UpgradeMigration,
} from "../types";

const CONVERSATION_PREFIX = "junior:conversation";
const CONVERSATION_SCHEMA_VERSION = 1;
const CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH = 10_000;
const CONVERSATION_BY_ACTIVITY_INDEX_KEY = `${CONVERSATION_PREFIX}:by-activity`;
const CONVERSATION_ACTIVE_INDEX_KEY = `${CONVERSATION_PREFIX}:active`;
const LEGACY_CONVERSATION_WORK_PREFIX = "junior:conversation-work";
const LEGACY_CONVERSATION_WORK_SCHEMA_VERSION = 1;
const LEGACY_CONVERSATION_WORK_INDEX_KEY = `${LEGACY_CONVERSATION_WORK_PREFIX}:index`;
const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_INDEX_KEY = `${AGENT_TURN_SESSION_PREFIX}:index`;
const THREAD_STATE_PREFIX = "thread-state";

interface ConversationIndexEntry {
  conversationId: string;
  score: number;
}

interface AwaitingContinuationSummary {
  conversationId: string;
  destination: Destination;
  resumeReason: "timeout" | "yield";
  sessionId: string;
  state: "awaiting_resume";
  updatedAtMs: number;
}

type RedisCommandClient = {
  sendCommand<T = unknown>(args: readonly string[]): Promise<T>;
};

function conversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:${conversationId}`;
}

function legacyConversationWorkKey(conversationId: string): string {
  return `${LEGACY_CONVERSATION_WORK_PREFIX}:state:${conversationId}`;
}

function threadStateKey(conversationId: string): string {
  return `${THREAD_STATE_PREFIX}:${conversationId}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueStringValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .map((value) => (typeof value === "string" ? value : undefined))
      .filter((value): value is string => Boolean(value)),
  );
}

function normalizeSource(value: unknown): Source | undefined {
  if (
    value === "api" ||
    value === "internal" ||
    value === "plugin" ||
    value === "scheduler" ||
    value === "slack"
  ) {
    return value;
  }
  return undefined;
}

function normalizeMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value;
}

function normalizeInput(value: unknown): InboundMessage["input"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = toOptionalString(value.text);
  if (!text) {
    return undefined;
  }
  return {
    text,
    authorId: toOptionalString(value.authorId),
    attachments: Array.isArray(value.attachments)
      ? [...value.attachments]
      : undefined,
    metadata: normalizeMetadata(value.metadata),
  };
}

function normalizeMessage(value: unknown): InboundMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const conversationId = toOptionalString(value.conversationId);
  const inboundMessageId = toOptionalString(value.inboundMessageId);
  const source = normalizeSource(value.source);
  const destination = parseDestination(value.destination);
  const createdAtMs = toOptionalNumber(value.createdAtMs);
  const receivedAtMs = toOptionalNumber(value.receivedAtMs);
  const input = normalizeInput(value.input);
  if (
    !conversationId ||
    !destination ||
    !inboundMessageId ||
    !source ||
    typeof createdAtMs !== "number" ||
    typeof receivedAtMs !== "number" ||
    !input
  ) {
    return undefined;
  }
  return {
    conversationId,
    destination,
    inboundMessageId,
    source,
    createdAtMs,
    receivedAtMs,
    input,
    injectedAtMs: toOptionalNumber(value.injectedAtMs),
  };
}

function normalizeLegacyLease(value: unknown): Lease | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const token = toOptionalString(value.leaseToken);
  const acquiredAtMs = toOptionalNumber(value.acquiredAtMs);
  const lastCheckInAtMs = toOptionalNumber(value.lastCheckInAtMs);
  const expiresAtMs = toOptionalNumber(value.leaseExpiresAtMs);
  if (
    !token ||
    typeof acquiredAtMs !== "number" ||
    typeof lastCheckInAtMs !== "number" ||
    typeof expiresAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    token,
    acquiredAtMs,
    lastCheckInAtMs,
    expiresAtMs,
  };
}

function compareMessages(left: InboundMessage, right: InboundMessage): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

/**
 * Decode legacy schema-v1 conversation-work state into the new conversation
 * execution record, preserving pending work and active lease/run intent.
 */
function normalizeLegacyConversation(
  conversationId: string,
  value: unknown,
): Conversation | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LEGACY_CONVERSATION_WORK_SCHEMA_VERSION
  ) {
    return undefined;
  }
  const storedConversationId = toOptionalString(value.conversationId);
  const destination = parseDestination(value.destination);
  const updatedAtMs = toOptionalNumber(value.updatedAtMs);
  if (
    storedConversationId !== conversationId ||
    !destination ||
    typeof updatedAtMs !== "number"
  ) {
    return undefined;
  }
  const normalizedMessages = Array.isArray(value.messages)
    ? value.messages
        .map(normalizeMessage)
        .filter((message): message is InboundMessage => Boolean(message))
    : [];
  if (
    normalizedMessages.some(
      (message) =>
        message.conversationId === conversationId &&
        !sameDestination(message.destination, destination),
    )
  ) {
    return undefined;
  }
  const messages = normalizedMessages
    .filter((message) => message.conversationId === conversationId)
    .sort(compareMessages);
  const pendingMessages = messages.filter(
    (message) => message.injectedAtMs === undefined,
  );
  const lease = normalizeLegacyLease(value.lease);
  const needsRun = value.needsRun === true || pendingMessages.length > 0;
  const status: ExecutionStatus = lease
    ? value.needsRun === true
      ? "awaiting_resume"
      : "running"
    : needsRun
      ? "pending"
      : "idle";
  const messageTimes = messages.flatMap((message) => [
    message.createdAtMs,
    message.receivedAtMs,
  ]);
  const createdAtMs =
    messageTimes.length > 0 ? Math.min(...messageTimes) : updatedAtMs;
  const lastActivityAtMs =
    messageTimes.length > 0 ? Math.max(...messageTimes) : updatedAtMs;

  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    conversationId,
    createdAtMs,
    destination,
    lastActivityAtMs,
    source: messages[0]?.source,
    updatedAtMs,
    execution: {
      status,
      inboundMessageIds: uniqueStrings(
        messages.map((message) => message.inboundMessageId),
      ),
      pendingCount: pendingMessages.length,
      pendingMessages,
      ...(lease ? { lease } : {}),
      lastEnqueuedAtMs: toOptionalNumber(value.lastEnqueuedAtMs),
      updatedAtMs,
    },
  };
}

function mergeLegacyConversation(
  existing: Conversation,
  legacy: Conversation,
): Conversation {
  if (
    existing.destination &&
    legacy.destination &&
    !sameDestination(existing.destination, legacy.destination)
  ) {
    throw new Error(
      `Legacy conversation work destination does not match conversation ${existing.conversationId}`,
    );
  }
  const knownInboundIds = new Set(existing.execution.inboundMessageIds);
  const pendingMessages = [
    ...existing.execution.pendingMessages,
    ...legacy.execution.pendingMessages.filter(
      (message) => !knownInboundIds.has(message.inboundMessageId),
    ),
  ].sort(compareMessages);
  const legacyIsRunnable = legacy.execution.status !== "idle";
  const existingIsIdle = existing.execution.status === "idle";
  const legacyLease =
    existingIsIdle && legacy.execution.lease
      ? { lease: legacy.execution.lease }
      : {};
  const legacyRunId =
    existingIsIdle && legacy.execution.runId
      ? { runId: legacy.execution.runId }
      : {};
  const legacyCheckpoint =
    existing.execution.lastCheckpointAtMs === undefined &&
    legacy.execution.lastCheckpointAtMs !== undefined
      ? { lastCheckpointAtMs: legacy.execution.lastCheckpointAtMs }
      : {};
  const legacyEnqueue =
    existing.execution.lastEnqueuedAtMs === undefined &&
    legacy.execution.lastEnqueuedAtMs !== undefined
      ? { lastEnqueuedAtMs: legacy.execution.lastEnqueuedAtMs }
      : {};
  const executionUpdatedAtMs = Math.max(
    existing.execution.updatedAtMs ?? existing.updatedAtMs,
    legacy.execution.updatedAtMs ?? legacy.updatedAtMs,
  );
  const status: ExecutionStatus =
    existingIsIdle && legacyIsRunnable
      ? legacy.execution.lease
        ? legacy.execution.status
        : "pending"
      : pendingMessages.length > 0 && existingIsIdle
        ? "pending"
        : existing.execution.status;

  return {
    ...existing,
    destination: existing.destination ?? legacy.destination,
    source: existing.source ?? legacy.source,
    createdAtMs: Math.min(existing.createdAtMs, legacy.createdAtMs),
    lastActivityAtMs: Math.max(
      existing.lastActivityAtMs,
      legacy.lastActivityAtMs,
    ),
    updatedAtMs: Math.max(existing.updatedAtMs, legacy.updatedAtMs),
    execution: {
      ...existing.execution,
      ...legacyLease,
      ...legacyRunId,
      ...legacyCheckpoint,
      ...legacyEnqueue,
      status,
      inboundMessageIds: uniqueStrings([
        ...existing.execution.inboundMessageIds,
        ...legacy.execution.inboundMessageIds,
      ]),
      pendingCount: pendingMessages.length,
      pendingMessages,
      updatedAtMs: executionUpdatedAtMs,
    },
  };
}

function compareIndexDescending(
  left: ConversationIndexEntry,
  right: ConversationIndexEntry,
): number {
  return (
    right.score - left.score ||
    right.conversationId.localeCompare(left.conversationId)
  );
}

function compareIndexAscending(
  left: ConversationIndexEntry,
  right: ConversationIndexEntry,
): number {
  return (
    left.score - right.score ||
    left.conversationId.localeCompare(right.conversationId)
  );
}

function normalizeIndexEntry(
  value: unknown,
): ConversationIndexEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const conversationId = toOptionalString(value.conversationId);
  const score = toOptionalNumber(value.score);
  if (!conversationId || typeof score !== "number") {
    return undefined;
  }
  return { conversationId, score };
}

function uniqueIndexEntries(value: unknown): ConversationIndexEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = new Map<string, ConversationIndexEntry>();
  for (const item of value) {
    const entry = normalizeIndexEntry(item);
    if (!entry) {
      continue;
    }
    const existing = entries.get(entry.conversationId);
    if (!existing || entry.score > existing.score) {
      entries.set(entry.conversationId, entry);
    }
  }
  return [...entries.values()];
}

function normalizeAwaitingContinuationSummary(
  value: unknown,
): AwaitingContinuationSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const conversationId = toOptionalString(value.conversationId);
  const sessionId = toOptionalString(value.sessionId);
  const state = value.state;
  const resumeReason = value.resumeReason;
  const destination = parseDestination(value.destination);
  const updatedAtMs = toOptionalNumber(value.updatedAtMs);
  if (
    !conversationId ||
    !sessionId ||
    state !== "awaiting_resume" ||
    (resumeReason !== "timeout" && resumeReason !== "yield") ||
    !destination ||
    typeof updatedAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    conversationId,
    destination,
    resumeReason,
    sessionId,
    state,
    updatedAtMs,
  };
}

function uniqueAwaitingContinuationSummaries(
  values: unknown[],
): AwaitingContinuationSummary[] {
  const summaries = new Map<string, AwaitingContinuationSummary>();
  for (const value of [...values].reverse()) {
    const summary = normalizeAwaitingContinuationSummary(value);
    if (!summary) {
      continue;
    }
    const key = `${summary.conversationId}:${summary.sessionId}`;
    if (!summaries.has(key)) {
      summaries.set(key, summary);
    }
  }
  return [...summaries.values()];
}

function redisIndexKey(indexKey: string): string {
  const prefix = getChatConfig().state.keyPrefix;
  return [...(prefix ? [prefix] : []), indexKey].join(":");
}

async function upsertEmulatedIndexEntry(args: {
  conversationId: string;
  indexKey: string;
  score: number;
  stateAdapter: StateAdapter;
}): Promise<void> {
  const existing = uniqueIndexEntries(
    await args.stateAdapter.get<unknown>(args.indexKey),
  );
  const next = [
    ...existing.filter((entry) => entry.conversationId !== args.conversationId),
    { conversationId: args.conversationId, score: args.score },
  ];
  const retained =
    args.indexKey === CONVERSATION_BY_ACTIVITY_INDEX_KEY
      ? next
          .sort(compareIndexDescending)
          .slice(0, CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH)
      : next.sort(compareIndexAscending);
  await args.stateAdapter.set(
    args.indexKey,
    retained,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
}

async function removeEmulatedIndexEntry(args: {
  conversationId: string;
  indexKey: string;
  stateAdapter: StateAdapter;
}): Promise<void> {
  const existing = uniqueIndexEntries(
    await args.stateAdapter.get<unknown>(args.indexKey),
  );
  const next = existing.filter(
    (entry) => entry.conversationId !== args.conversationId,
  );
  if (next.length === existing.length) {
    return;
  }
  await args.stateAdapter.set(args.indexKey, next, JUNIOR_THREAD_STATE_TTL_MS);
}

async function upsertRedisIndexEntry(args: {
  client: RedisCommandClient;
  conversationId: string;
  indexKey: string;
  score: number;
}): Promise<void> {
  const key = redisIndexKey(args.indexKey);
  if (args.indexKey === CONVERSATION_BY_ACTIVITY_INDEX_KEY) {
    const upsertBoundedActivityScript = `
      redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
      redis.call("PEXPIRE", KEYS[1], ARGV[3])
      local extra = redis.call("ZCARD", KEYS[1]) - tonumber(ARGV[4])
      if extra > 0 then
        redis.call("ZREMRANGEBYRANK", KEYS[1], 0, extra - 1)
      end
      return 1
    `;
    await args.client.sendCommand([
      "EVAL",
      upsertBoundedActivityScript,
      "1",
      key,
      String(args.score),
      args.conversationId,
      String(JUNIOR_THREAD_STATE_TTL_MS),
      String(CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH),
    ]);
    return;
  }

  await args.client.sendCommand([
    "ZADD",
    key,
    String(args.score),
    args.conversationId,
  ]);
  await args.client.sendCommand([
    "PEXPIRE",
    key,
    String(JUNIOR_THREAD_STATE_TTL_MS),
  ]);
}

async function removeRedisIndexEntry(args: {
  client: RedisCommandClient;
  conversationId: string;
  indexKey: string;
}): Promise<void> {
  await args.client.sendCommand([
    "ZREM",
    redisIndexKey(args.indexKey),
    args.conversationId,
  ]);
}

async function upsertConversationIndexes(args: {
  conversation: Conversation;
  redisStateAdapter?: RedisStateAdapter;
  stateAdapter: StateAdapter;
}): Promise<void> {
  const redisClient = args.redisStateAdapter?.getClient() as
    | RedisCommandClient
    | undefined;
  const upsert = redisClient
    ? (indexKey: string, score: number) =>
        upsertRedisIndexEntry({
          client: redisClient,
          conversationId: args.conversation.conversationId,
          indexKey,
          score,
        })
    : (indexKey: string, score: number) =>
        upsertEmulatedIndexEntry({
          stateAdapter: args.stateAdapter,
          conversationId: args.conversation.conversationId,
          indexKey,
          score,
        });
  const remove = redisClient
    ? (indexKey: string) =>
        removeRedisIndexEntry({
          client: redisClient,
          conversationId: args.conversation.conversationId,
          indexKey,
        })
    : (indexKey: string) =>
        removeEmulatedIndexEntry({
          stateAdapter: args.stateAdapter,
          conversationId: args.conversation.conversationId,
          indexKey,
        });

  await upsert(
    CONVERSATION_BY_ACTIVITY_INDEX_KEY,
    args.conversation.lastActivityAtMs,
  );
  if (args.conversation.execution.status === "idle") {
    await remove(CONVERSATION_ACTIVE_INDEX_KEY);
    return;
  }
  await upsert(
    CONVERSATION_ACTIVE_INDEX_KEY,
    args.conversation.execution.updatedAtMs ?? args.conversation.updatedAtMs,
  );
}

async function removeLegacyIndexEntry(args: {
  conversationId: string;
  stateAdapter: StateAdapter;
}): Promise<void> {
  const existing = uniqueStringValues(
    await args.stateAdapter.get<unknown>(LEGACY_CONVERSATION_WORK_INDEX_KEY),
  );
  const next = existing.filter((id) => id !== args.conversationId);
  if (next.length === existing.length) {
    return;
  }
  if (next.length === 0) {
    await args.stateAdapter.delete(LEGACY_CONVERSATION_WORK_INDEX_KEY);
    return;
  }
  await args.stateAdapter.set(
    LEGACY_CONVERSATION_WORK_INDEX_KEY,
    next,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
}

/**
 * Move indexed legacy work records into conversation records, update the new
 * indexes, then delete each legacy key only after its write or merge succeeds.
 */
async function migrateLegacyConversationWorkRedisState(
  context: MigrationContext,
): Promise<MigrationResult> {
  const legacyIds = uniqueStringValues(
    await context.stateAdapter.get<unknown>(LEGACY_CONVERSATION_WORK_INDEX_KEY),
  );
  const result: MigrationResult = {
    existing: 0,
    migrated: 0,
    missing: 0,
    scanned: legacyIds.length,
  };

  for (const conversationId of legacyIds) {
    const legacyKey = legacyConversationWorkKey(conversationId);
    const raw = await context.stateAdapter.get(legacyKey);
    if (raw == null) {
      result.missing += 1;
      await removeLegacyIndexEntry({
        conversationId,
        stateAdapter: context.stateAdapter,
      });
      continue;
    }

    const conversation = normalizeLegacyConversation(conversationId, raw);
    if (!conversation) {
      throw new Error(
        `Legacy conversation work state is invalid for ${conversationId}`,
      );
    }

    const existingConversation = await getConversation({
      conversationId,
      state: context.stateAdapter,
    });
    if (existingConversation) {
      const mergedConversation = mergeLegacyConversation(
        existingConversation,
        conversation,
      );
      await context.stateAdapter.set(
        conversationKey(conversationId),
        mergedConversation,
        JUNIOR_THREAD_STATE_TTL_MS,
      );
      await upsertConversationIndexes({
        conversation: mergedConversation,
        redisStateAdapter: context.redisStateAdapter,
        stateAdapter: context.stateAdapter,
      });
      result.existing += 1;
      await context.stateAdapter.delete(legacyKey);
      await removeLegacyIndexEntry({
        conversationId,
        stateAdapter: context.stateAdapter,
      });
      continue;
    }

    await context.stateAdapter.set(
      conversationKey(conversationId),
      conversation,
      JUNIOR_THREAD_STATE_TTL_MS,
    );
    await upsertConversationIndexes({
      conversation,
      redisStateAdapter: context.redisStateAdapter,
      stateAdapter: context.stateAdapter,
    });
    await context.stateAdapter.delete(legacyKey);
    await removeLegacyIndexEntry({
      conversationId,
      stateAdapter: context.stateAdapter,
    });
    result.migrated += 1;
  }

  return result;
}

async function isActiveContinuationSummary(
  context: MigrationContext,
  summary: AwaitingContinuationSummary,
): Promise<boolean> {
  const rawState =
    (await context.stateAdapter.get<Record<string, unknown>>(
      threadStateKey(summary.conversationId),
    )) ?? {};
  const conversation = coerceThreadConversationState(rawState);
  return conversation.processing.activeTurnId === summary.sessionId;
}

async function seedAwaitingContinuationConversationWork(
  context: MigrationContext,
  result: MigrationResult,
): Promise<void> {
  const summaries = uniqueAwaitingContinuationSummaries(
    await context.stateAdapter.getList(AGENT_TURN_SESSION_INDEX_KEY),
  );
  result.scanned += summaries.length;

  for (const summary of summaries) {
    if (!(await isActiveContinuationSummary(context, summary))) {
      continue;
    }
    const existingConversation = await getConversation({
      conversationId: summary.conversationId,
      state: context.stateAdapter,
    });
    if (
      existingConversation?.destination &&
      !sameDestination(existingConversation.destination, summary.destination)
    ) {
      throw new Error(
        `Awaiting continuation destination does not match conversation ${summary.conversationId}`,
      );
    }
    if (
      existingConversation &&
      existingConversation.execution.status !== "idle"
    ) {
      continue;
    }
    await requestConversationWork({
      conversationId: summary.conversationId,
      destination: summary.destination,
      nowMs: Math.max(
        summary.updatedAtMs,
        existingConversation?.updatedAtMs ?? 0,
      ),
      state: context.stateAdapter,
    });
    if (existingConversation) {
      result.existing += 1;
    } else {
      result.migrated += 1;
    }
  }
}

async function migrateRedisConversationState(
  context: MigrationContext,
): Promise<MigrationResult> {
  const result = await migrateLegacyConversationWorkRedisState(context);
  await seedAwaitingContinuationConversationWork(context, result);
  return result;
}

export const redisConversationStateMigration: UpgradeMigration = {
  // TODO(after 2026-07-01): remove after deployed installs have had a release
  // window to move legacy conversation-work Redis state forward.
  name: "migrate-redis-conversation-state",
  run: migrateRedisConversationState,
};
