/**
 * Expiring conversation mailbox and execution index store.
 *
 * The conversation record owns pending inbound work, execution status, and the
 * lease. `conversation:active` feeds heartbeat recovery and contains every
 * conversation with runnable work. `writeConversation` keeps it in step.
 * `conversation:by-activity` supports legacy SQL import only; SQL owns durable
 * conversation metadata in configured runtime.
 */
import { isPersonInput } from "@/chat/conversations/kind-behavior";
import { randomUUID } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import { destinationSchema, type Destination } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
import { getChatConfig } from "@/chat/config";
import { parseDestination, sameDestination } from "@/chat/destination";
import { parseStoredSlackActor, type StoredSlackActor } from "@/chat/actor";
import { reviewItemChangeRecordSchema } from "@/chat/review-items/change-record";
import {
  getDefaultRedisStateAdapterFor,
  getStateAdapter,
  getStateValues,
} from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { logException } from "@/chat/logging";
import {
  normalizeMessageSenders,
  withMessageSenders,
  type InboundMessageSenders,
} from "./message-sender";

const CONVERSATION_PREFIX = "junior:conversation:v2";
const CONVERSATION_SCHEMA_VERSION = 2;
const CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH = 10_000;
const CONVERSATION_INDEX_LOCK_TTL_MS = 10_000;
const CONVERSATION_INDEX_LOCK_WAIT_MS = 2_000;
const CONVERSATION_INDEX_LOCK_RETRY_MS = 25;
const CONVERSATION_MUTATION_LOCK_TTL_MS = 10_000;
const CONVERSATION_MUTATION_WAIT_MS = 10_000;
const CONVERSATION_MUTATION_RETRY_MS = 25;

class InvalidConversationRecordError extends Error {
  constructor(conversationId: string) {
    super(`Conversation record is invalid for ${conversationId}`);
    this.name = "InvalidConversationRecordError";
  }
}

/** Return whether an error means a stored conversation record failed validation. */
export function isInvalidConversationRecordError(
  error: unknown,
): error is InvalidConversationRecordError {
  return error instanceof InvalidConversationRecordError;
}

class ConversationMutationFencedError extends Error {
  constructor(conversationId: string) {
    super(
      `Conversation mutation lock was lost before write for ${conversationId}`,
    );
    this.name = "ConversationMutationFencedError";
  }
}

export const CONVERSATION_BY_ACTIVITY_INDEX_KEY = `${CONVERSATION_PREFIX}:by-activity`;
export const CONVERSATION_ACTIVE_INDEX_KEY = `${CONVERSATION_PREFIX}:active`;
export const CONVERSATION_WORK_LEASE_TTL_MS = 90_000;
export const CONVERSATION_WORK_CHECK_IN_INTERVAL_MS = 15_000;
export const CONVERSATION_WORK_STALE_ENQUEUE_MS = 60_000;
export const CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS = 5;
export const CONVERSATION_WORK_MAX_RETRIES = 5;

const inboundMessageSourceSchema = z.enum([
  "api",
  "internal",
  "local",
  "plugin",
  "event",
  "scheduler",
  "slack",
  "web",
]);

export type Source = z.output<typeof inboundMessageSourceSchema>;

export type ExecutionStatus =
  | "paused"
  | "failed"
  | "idle"
  | "pending"
  | "running";

const agentInputSchema = z
  .object({
    attachments: z.array(z.unknown()).optional(),
    authorId: z.string().min(1).optional(),
    /** Identity of the input author, resolved at ingress. */
    authorIdentityId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Review item change that this input reports, on any Source. */
    reviewItemChange: reviewItemChangeRecordSchema.optional(),
    text: z.string(),
  })
  .strict()
  .refine((input) => input.text.trim() || input.attachments?.length, {
    message: "agent input requires text or attachments",
  });

export type AgentInput = z.output<typeof agentInputSchema>;

/** Durable delivery modes for pending inbound mailbox work. */
export const inboundMessageDeliverySchema = z.enum(["defer", "interrupt"]);

export type InboundMessageDelivery = z.output<
  typeof inboundMessageDeliverySchema
>;

/** Sentry trace propagation headers. A malformed value is dropped, not rejected. */
export const traceContextSchema = z
  .object({
    baggage: z.string().optional(),
    sentryTrace: z.string().min(1),
  })
  .optional()
  .catch(undefined);

/** Canonical durable mailbox entry owned by task execution. */
export const inboundMessageSchema = z
  .object({
    attemptCount: z.number().finite().optional(),
    conversationId: z.string().refine((value) => value.trim().length > 0),
    createdAtMs: z.number().finite(),
    delivery: inboundMessageDeliverySchema,
    destination: destinationSchema.optional(),
    inboundMessageId: z.string().refine((value) => value.trim().length > 0),
    input: agentInputSchema,
    receivedAtMs: z.number().finite(),
    source: inboundMessageSourceSchema,
    traceContext: traceContextSchema,
  })
  .strict();

export type InboundMessage = z.output<typeof inboundMessageSchema>;

export type TraceContext = NonNullable<z.output<typeof traceContextSchema>>;

/** Redis mailbox shape kept for deployed workers that still require this field. */
const storedInboundMessageSchema = inboundMessageSchema.extend({
  publishExternally: z.boolean(),
});

type StoredInboundMessage = z.output<typeof storedInboundMessageSchema>;

export interface Lease {
  acquiredAtMs: number;
  expiresAtMs: number;
  lastCheckInAtMs: number;
  token: string;
}

/** Durable request to stop one Conversation run. */
export interface ConversationStop {
  inboundMessageIds: string[];
  runId: string;
}

export interface ConversationExecution {
  inboundMessageIds: string[];
  /** Sender fields of the ids in `inboundMessageIds` that have them. */
  messageSenders?: InboundMessageSenders;
  lastCheckpointAtMs?: number;
  lastEnqueuedAtMs?: number;
  lastProgressAtMs?: number;
  retryCount?: number;
  lease?: Lease;
  pendingCount: number;
  pendingMessages: InboundMessage[];
  runId?: string;
  status: ExecutionStatus;
  updatedAtMs?: number;
}

/** Redis execution state. SQL owns the durable Conversation. */
export interface ConversationExecutionState {
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: ConversationExecution;
  lastActivityAtMs: number;
  actor?: StoredSlackActor;
  schemaVersion: 2;
  source?: Source;
  title?: string;
  updatedAtMs: number;
}

export interface ConversationWorkLease {
  acquiredAtMs: number;
  lastCheckInAtMs: number;
  leaseExpiresAtMs: number;
  leaseToken: string;
}

export interface ConversationWorkState extends ConversationExecutionState {
  lastEnqueuedAtMs?: number;
  lease?: ConversationWorkLease;
  messages: InboundMessage[];
  needsRun: boolean;
}

export interface StartConversationWorkAcquired {
  leaseExpiresAtMs: number;
  leaseToken: string;
  status: "acquired";
}

export interface StartConversationWorkActive {
  leaseExpiresAtMs: number;
  status: "active";
}

export interface StartConversationWorkNoWork {
  status: "no_work";
}

export type StartConversationWorkResult =
  | StartConversationWorkAcquired
  | StartConversationWorkActive
  | StartConversationWorkNoWork;

export interface AppendInboundMessageResult {
  status: "appended" | "duplicate";
}

export interface AppendAndEnqueueInboundMessageResult extends AppendInboundMessageResult {
  queueMessageId?: string;
}

/** Result of requesting that the current Conversation run stop. */
export type StopConversationWorkResult =
  | { status: "no_work" }
  | { runId: string; status: "requested"; pendingMessages: InboundMessage[] };

/** Result of recording an inbound message id outside the mailbox. */
export interface ClaimInboundMessageResult {
  status: "claimed" | "duplicate";
}

/** Result of clearing one stop observed by the matching leased run. */
export interface CompleteConversationStopResult {
  status: "cleared" | "lost_lease" | "none";
  removedInboundMessageIds: string[];
}

/** Result of an append that rejects new work while a Conversation is runnable. */
export type AppendExclusiveInboundMessageResult =
  | AppendInboundMessageResult
  | { status: "active" };

/** Exclusive append result with an optional queue delivery id. */
export type AppendAndEnqueueExclusiveInboundMessageResult =
  | AppendAndEnqueueInboundMessageResult
  | { status: "active" };

export interface RequestConversationWorkResult {
  status: "created" | "updated";
}

interface ConversationIndexEntry {
  conversationId: string;
  score: number;
}

interface ConversationIndexStore {
  list(args: {
    indexKey: string;
    limit?: number;
    offset?: number;
    order: "asc" | "desc";
    scoreMax?: number;
  }): Promise<ConversationIndexEntry[]>;
  remove(args: { conversationId: string; indexKey: string }): Promise<void>;
  upsert(args: {
    conversationId: string;
    indexKey: string;
    score: number;
  }): Promise<void>;
}

type RedisCommandClient = {
  sendCommand<T = unknown>(args: readonly string[]): Promise<T>;
};

function conversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:${conversationId}`;
}

function conversationStopKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:stop:${conversationId}`;
}

function deferredMoveKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:deferred-move:${conversationId}`;
}

function indexLockKey(indexKey: string): string {
  return `${indexKey}:lock`;
}

function mutationLockKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}:mutation:${conversationId}`;
}

function now(): number {
  return Date.now();
}

function compareMessages(left: InboundMessage, right: InboundMessage): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function inputHasAttachments(input: AgentInput): boolean {
  return Array.isArray(input.attachments) && input.attachments.length > 0;
}

/**
 * Upgrade a still-pending payload when a duplicate source event carries file
 * attachments the stored copy lacks (Slack `app_mention`/`message` twins),
 * keeping the stored ordering timestamps and delivery attempts.
 */
function upgradedPendingMessage(
  stored: InboundMessage,
  duplicate: InboundMessage,
): InboundMessage {
  const promotesInterrupt =
    stored.delivery === "defer" && duplicate.delivery === "interrupt";
  const delivery = promotesInterrupt ? "interrupt" : stored.delivery;
  const input = promotesInterrupt
    ? {
        ...duplicate.input,
        ...(inputHasAttachments(duplicate.input) ||
        !inputHasAttachments(stored.input)
          ? undefined
          : { attachments: stored.input.attachments }),
      }
    : inputHasAttachments(duplicate.input) && !inputHasAttachments(stored.input)
      ? duplicate.input
      : stored.input;
  if (input === stored.input && delivery === stored.delivery) {
    return stored;
  }
  return { ...stored, delivery, input };
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSource(value: unknown): Source | undefined {
  const parsed = inboundMessageSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeExecutionStatus(value: unknown): ExecutionStatus | undefined {
  if (value === "paused") {
    return value;
  }
  if (
    value === "failed" ||
    value === "idle" ||
    value === "pending" ||
    value === "running"
  ) {
    return value;
  }
  return undefined;
}

function normalizeMessage(value: unknown): InboundMessage | undefined {
  const parsed = storedInboundMessageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const {
    publishExternally: _publishExternally,
    traceContext,
    ...message
  } = parsed.data;
  // A dropped trace context must not leave a key that old strict readers reject.
  return traceContext ? { ...message, traceContext } : message;
}

function storeMessage(
  message: InboundMessage,
  publishExternally: boolean,
): StoredInboundMessage {
  return { ...message, publishExternally };
}

/** Whether this is the final attempt before an unacked message is dead-lettered. */
export function isFinalAttempt(
  message: Pick<InboundMessage, "attemptCount">,
): boolean {
  return (
    (message.attemptCount ?? 0) >= CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS - 1
  );
}

function normalizeActor(value: unknown): StoredSlackActor | undefined {
  return parseStoredSlackActor(value);
}

function normalizeLease(value: unknown): Lease | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const token = toOptionalString(value.token);
  const acquiredAtMs = toOptionalNumber(value.acquiredAtMs);
  const lastCheckInAtMs = toOptionalNumber(value.lastCheckInAtMs);
  const expiresAtMs = toOptionalNumber(value.expiresAtMs);
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

function normalizeStop(value: unknown): ConversationStop | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inboundMessageIds = Array.isArray(value.inboundMessageIds)
    ? uniqueStrings(
        value.inboundMessageIds.filter(
          (id): id is string => typeof id === "string",
        ),
      )
    : [];
  const runId = toOptionalString(value.runId);
  return runId ? { inboundMessageIds, runId } : undefined;
}

/** Decode stored execution state. */
function normalizeExecution(
  conversationId: string,
  value: unknown,
): ConversationExecution | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = normalizeExecutionStatus(value.status);
  if (!status) {
    return undefined;
  }
  const pendingMessages: InboundMessage[] = [];
  if (Array.isArray(value.pendingMessages)) {
    for (const rawMessage of value.pendingMessages) {
      const message = normalizeMessage(rawMessage);
      if (!message || message.conversationId !== conversationId) {
        return undefined;
      }
      pendingMessages.push(message);
    }
    pendingMessages.sort(compareMessages);
  }
  const inboundMessageIds = Array.isArray(value.inboundMessageIds)
    ? uniqueStrings(
        value.inboundMessageIds
          .map((id) => (typeof id === "string" ? id : undefined))
          .filter((id): id is string => Boolean(id)),
      )
    : [];
  const messageSenders = withMessageSenders(
    normalizeMessageSenders(value.messageSenders),
    pendingMessages,
  );

  return {
    status,
    inboundMessageIds: uniqueStrings([
      ...inboundMessageIds,
      ...pendingMessages.map((message) => message.inboundMessageId),
    ]),
    ...(messageSenders ? { messageSenders } : undefined),
    pendingCount: pendingMessages.length,
    pendingMessages,
    lease: normalizeLease(value.lease),
    lastCheckpointAtMs: toOptionalNumber(value.lastCheckpointAtMs),
    lastEnqueuedAtMs: toOptionalNumber(value.lastEnqueuedAtMs),
    lastProgressAtMs: toOptionalNumber(value.lastProgressAtMs),
    retryCount: toOptionalNumber(value.retryCount),
    runId: toOptionalString(value.runId),
    updatedAtMs: toOptionalNumber(value.updatedAtMs),
  };
}

/** Decode current conversation records. */
function normalizeConversation(
  conversationId: string,
  value: unknown,
): ConversationExecutionState | undefined {
  if (!isRecord(value) || value.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
    return undefined;
  }
  const storedConversationId = toOptionalString(value.conversationId);
  const createdAtMs = toOptionalNumber(value.createdAtMs);
  const lastActivityAtMs = toOptionalNumber(value.lastActivityAtMs);
  const updatedAtMs = toOptionalNumber(value.updatedAtMs);
  const execution = normalizeExecution(conversationId, value.execution);
  const destination =
    value.destination === undefined
      ? undefined
      : parseDestination(value.destination);
  if (
    storedConversationId !== conversationId ||
    typeof createdAtMs !== "number" ||
    typeof lastActivityAtMs !== "number" ||
    typeof updatedAtMs !== "number" ||
    !execution ||
    (value.destination !== undefined && !destination)
  ) {
    return undefined;
  }
  // Pending messages without destination use the conversation destination.
  // Only a conflicting explicit message destination is invalid.
  if (
    execution.pendingMessages.length > 0 &&
    execution.pendingMessages.some((message) => {
      if (!message.destination) {
        return false;
      }
      return !destination || !sameDestination(message.destination, destination);
    })
  ) {
    return undefined;
  }
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    conversationId,
    createdAtMs,
    lastActivityAtMs,
    updatedAtMs,
    execution,
    ...(destination ? { destination } : undefined),
    ...(toOptionalString(value.title)
      ? { title: toOptionalString(value.title) }
      : undefined),
    ...(toOptionalString(value.channelName)
      ? { channelName: toOptionalString(value.channelName) }
      : undefined),
    ...(normalizeActor(value.actor)
      ? { actor: normalizeActor(value.actor) }
      : undefined),
    ...(normalizeSource(value.source)
      ? { source: normalizeSource(value.source) }
      : undefined),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination;
  nowMs: number;
  source?: Source;
}): ConversationExecutionState {
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    conversationId: args.conversationId,
    createdAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    ...(args.destination ? { destination: args.destination } : undefined),
    ...(args.source ? { source: args.source } : undefined),
    execution: {
      status: "idle",
      inboundMessageIds: [],
      pendingCount: 0,
      pendingMessages: [],
      updatedAtMs: args.nowMs,
    },
  };
}

function isLeaseActive(lease: Lease | undefined, nowMs: number): boolean {
  return Boolean(lease && lease.expiresAtMs > nowMs);
}

function pendingMessages(
  conversation: ConversationExecutionState,
): InboundMessage[] {
  return [...conversation.execution.pendingMessages].sort(compareMessages);
}

/**
 * The one runnable check: a worker must start or resume this Conversation.
 * A `failed` execution is runnable only while new input waits.
 */
function hasRunnableWork(conversation: ConversationExecutionState): boolean {
  const { status } = conversation.execution;
  return (
    (status !== "failed" && status !== "idle") ||
    conversation.execution.pendingMessages.length > 0
  );
}

/**
 * Reject an execution that no transition may write. Only a Run holds the
 * lease, and an `idle` Conversation has no input that waits.
 */
function assertLegalExecution(
  conversationId: string,
  execution: ConversationExecution,
): void {
  const { lease, pendingMessages, status } = execution;
  if (lease && status !== "running" && status !== "paused") {
    throw new Error(
      `Conversation execution ${status} cannot hold a lease for ${conversationId}`,
    );
  }
  if (status === "idle" && pendingMessages.length > 0) {
    throw new Error(
      `Conversation execution idle cannot have pending messages for ${conversationId}`,
    );
  }
}

function executionWithPendingMessages(
  execution: ConversationExecution,
  pending: InboundMessage[],
): ConversationExecution {
  const pendingMessages = [...pending].sort(compareMessages);
  const messageSenders = withMessageSenders(
    execution.messageSenders,
    pendingMessages,
  );
  return {
    ...execution,
    inboundMessageIds: uniqueStrings([
      ...execution.inboundMessageIds,
      ...pendingMessages.map((message) => message.inboundMessageId),
    ]),
    ...(messageSenders ? { messageSenders } : undefined),
    pendingMessages,
    pendingCount: pendingMessages.length,
  };
}

function withExecutionUpdate(
  conversation: ConversationExecutionState,
  execution: ConversationExecution,
  nowMs: number,
): ConversationExecutionState {
  return {
    ...conversation,
    updatedAtMs: nowMs,
    execution: {
      ...executionWithPendingMessages(execution, execution.pendingMessages),
      updatedAtMs: nowMs,
    },
  };
}

async function getConnectedState(
  stateAdapter?: StateAdapter,
): Promise<StateAdapter> {
  const state = stateAdapter ?? getStateAdapter();
  await state.connect();
  return state;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

async function withIndexLock<T>(
  state: StateAdapter,
  indexKey: string,
  callback: () => Promise<T>,
): Promise<T> {
  const startedAtMs = now();
  let lock: Lock | null;
  while (true) {
    lock = await state.acquireLock(
      indexLockKey(indexKey),
      CONVERSATION_INDEX_LOCK_TTL_MS,
    );
    if (lock) {
      break;
    }
    if (now() - startedAtMs >= CONVERSATION_INDEX_LOCK_WAIT_MS) {
      throw new Error(
        `Could not acquire conversation index lock for ${indexKey}`,
      );
    }
    await sleep(CONVERSATION_INDEX_LOCK_RETRY_MS);
  }
  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
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

function retainedIndexEntries(
  indexKey: string,
  entries: ConversationIndexEntry[],
): ConversationIndexEntry[] {
  if (indexKey === CONVERSATION_BY_ACTIVITY_INDEX_KEY) {
    return entries
      .sort(compareIndexDescending)
      .slice(0, CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH);
  }
  if (indexKey === CONVERSATION_ACTIVE_INDEX_KEY) {
    return entries.sort(compareIndexAscending);
  }
  throw new Error(`Unknown conversation index ${indexKey}`);
}

function redisIndexKey(indexKey: string): string {
  const prefix = getChatConfig().state.keyPrefix;
  return [...(prefix ? [prefix] : []), indexKey].join(":");
}

function parseRedisIndexEntries(values: unknown): ConversationIndexEntry[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const entries: ConversationIndexEntry[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const conversationId = toOptionalString(values[index]);
    const rawScore: unknown = values[index + 1];
    const score = typeof rawScore === "number" ? rawScore : Number(rawScore);
    if (!conversationId || !Number.isFinite(score)) {
      continue;
    }
    entries.push({ conversationId, score });
  }
  return entries;
}

function redisConversationIndexStore(
  client: RedisCommandClient,
): ConversationIndexStore {
  const upsertBoundedActivityScript = `
    redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2])
    redis.call("PEXPIRE", KEYS[1], ARGV[3])
    local extra = redis.call("ZCARD", KEYS[1]) - tonumber(ARGV[4])
    if extra > 0 then
      redis.call("ZREMRANGEBYRANK", KEYS[1], 0, extra - 1)
    end
    return 1
  `;

  return {
    async list(args) {
      const key = redisIndexKey(args.indexKey);
      const limit = args.limit;
      const offset = Math.max(0, args.offset ?? 0);
      if (limit === 0) {
        return [];
      }
      const values =
        args.scoreMax !== undefined
          ? await client.sendCommand<unknown[]>([
              "ZRANGEBYSCORE",
              key,
              "-inf",
              String(args.scoreMax),
              "WITHSCORES",
              ...(limit !== undefined || offset > 0
                ? ["LIMIT", String(offset), String(limit ?? 1_000_000_000)]
                : []),
            ])
          : await client.sendCommand<unknown[]>([
              args.order === "asc" ? "ZRANGE" : "ZREVRANGE",
              key,
              String(offset),
              String(
                limit === undefined ? -1 : offset + Math.max(0, limit - 1),
              ),
              "WITHSCORES",
            ]);
      return parseRedisIndexEntries(values);
    },
    async remove(args) {
      await client.sendCommand([
        "ZREM",
        redisIndexKey(args.indexKey),
        args.conversationId,
      ]);
    },
    async upsert(args) {
      const key = redisIndexKey(args.indexKey);
      if (args.indexKey === CONVERSATION_BY_ACTIVITY_INDEX_KEY) {
        await client.sendCommand([
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
      if (args.indexKey === CONVERSATION_ACTIVE_INDEX_KEY) {
        await client.sendCommand([
          "ZADD",
          key,
          String(args.score),
          args.conversationId,
        ]);
        await client.sendCommand([
          "PEXPIRE",
          key,
          String(JUNIOR_THREAD_STATE_TTL_MS),
        ]);
        return;
      }
      throw new Error(`Unknown conversation index ${args.indexKey}`);
    },
  };
}

function emulatedConversationIndexStore(
  state: StateAdapter,
): ConversationIndexStore {
  const readIndex = async (
    indexKey: string,
  ): Promise<ConversationIndexEntry[]> =>
    uniqueIndexEntries(await state.get<unknown>(indexKey));

  const writeIndex = async (
    indexKey: string,
    entries: ConversationIndexEntry[],
  ): Promise<void> => {
    await state.set(indexKey, entries, JUNIOR_THREAD_STATE_TTL_MS);
  };

  return {
    async list(args) {
      const entries = (await readIndex(args.indexKey))
        .filter((entry) =>
          args.scoreMax === undefined ? true : entry.score <= args.scoreMax,
        )
        .sort(
          args.order === "asc" ? compareIndexAscending : compareIndexDescending,
        );
      const offset = Math.max(0, args.offset ?? 0);
      return entries.slice(
        offset,
        args.limit === undefined ? entries.length : offset + args.limit,
      );
    },
    async remove(args) {
      await withIndexLock(state, args.indexKey, async () => {
        const entries = await readIndex(args.indexKey);
        const next = entries.filter(
          (entry) => entry.conversationId !== args.conversationId,
        );
        if (next.length === entries.length) {
          return;
        }
        await writeIndex(args.indexKey, next);
      });
    },
    async upsert(args) {
      await withIndexLock(state, args.indexKey, async () => {
        const entries = await readIndex(args.indexKey);
        const withoutCurrent = entries.filter(
          (entry) => entry.conversationId !== args.conversationId,
        );
        const next = retainedIndexEntries(args.indexKey, [
          ...withoutCurrent,
          { conversationId: args.conversationId, score: args.score },
        ]);
        await writeIndex(args.indexKey, next);
      });
    },
  };
}

async function getConversationIndexStore(
  state: StateAdapter,
): Promise<ConversationIndexStore> {
  const redisStateAdapter = await getDefaultRedisStateAdapterFor(state);
  if (redisStateAdapter) {
    return redisConversationIndexStore(redisStateAdapter.getClient());
  }
  return emulatedConversationIndexStore(state);
}

async function upsertIndexEntry(args: {
  conversationId: string;
  indexKey: string;
  score: number;
  state: StateAdapter;
}): Promise<void> {
  const index = await getConversationIndexStore(args.state);
  await index.upsert({
    conversationId: args.conversationId,
    indexKey: args.indexKey,
    score: args.score,
  });
}

async function removeIndexEntry(args: {
  conversationId: string;
  indexKey: string;
  state: StateAdapter;
}): Promise<void> {
  const index = await getConversationIndexStore(args.state);
  await index.remove({
    conversationId: args.conversationId,
    indexKey: args.indexKey,
  });
}

async function acquireMutationLock(
  state: StateAdapter,
  conversationId: string,
): Promise<Lock> {
  const startedAtMs = now();
  while (true) {
    const lock = await state.acquireLock(
      mutationLockKey(conversationId),
      CONVERSATION_MUTATION_LOCK_TTL_MS,
    );
    if (lock) {
      return lock;
    }
    if (now() - startedAtMs >= CONVERSATION_MUTATION_WAIT_MS) {
      throw new Error(
        `Could not acquire conversation mutation lock for ${conversationId}`,
      );
    }
    await sleep(CONVERSATION_MUTATION_RETRY_MS);
  }
}

async function withConversationMutation<T>(
  args: {
    conversationId: string;
    state?: StateAdapter;
  },
  callback: (state: StateAdapter, lock: Lock) => Promise<T>,
): Promise<T> {
  const state = await getConnectedState(args.state);
  const lock = await acquireMutationLock(state, args.conversationId);
  try {
    return await callback(state, lock);
  } finally {
    await state.releaseLock(lock);
  }
}

async function readConversation(
  state: StateAdapter,
  conversationId: string,
): Promise<ConversationExecutionState | undefined> {
  return conversationFromValue(
    conversationId,
    await state.get(conversationKey(conversationId)),
  );
}

function conversationFromValue(
  conversationId: string,
  raw: unknown,
): ConversationExecutionState | undefined {
  if (raw == null) {
    return undefined;
  }
  const conversation = normalizeConversation(conversationId, raw);
  if (!conversation) {
    throw new InvalidConversationRecordError(conversationId);
  }
  return conversation;
}

/**
 * Persist a conversation and refresh its reporting and active-recovery indexes.
 *
 * Conversation writes are lock-serialized blind whole-record writes, so the
 * mutation lock is re-validated (and extended) immediately before the write:
 * a stalled mutator that lost its lock must fail loudly instead of clobbering
 * a newer record with a stale copy.
 */
async function writeConversation(
  state: StateAdapter,
  lock: Lock,
  conversation: ConversationExecutionState,
): Promise<void> {
  const execution = executionWithPendingMessages(
    conversation.execution,
    conversation.execution.pendingMessages,
  );
  assertLegalExecution(conversation.conversationId, execution);
  const next: ConversationExecutionState = {
    ...conversation,
    execution,
  };
  await fenceConversationMutation(state, lock, next.conversationId);
  // TODO(dcramer): Remove the stored publishExternally field after no deployed
  // mailbox reader requires it. Destination is used only to write this old
  // Redis shape. Current workers ignore the field.
  const hasSlackDestination = next.destination?.platform === "slack";
  const stored = {
    ...next,
    execution: {
      ...next.execution,
      pendingMessages: next.execution.pendingMessages.map((message) =>
        storeMessage(
          message,
          hasSlackDestination &&
            (message.source === "slack" ||
              message.source === "event" ||
              message.source === "plugin" ||
              message.source === "scheduler"),
        ),
      ),
    },
  };
  await state.set(
    conversationKey(next.conversationId),
    stored,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
  await upsertIndexEntry({
    state,
    indexKey: CONVERSATION_BY_ACTIVITY_INDEX_KEY,
    conversationId: next.conversationId,
    score: next.lastActivityAtMs,
  });
  if (!hasRunnableWork(next)) {
    await removeIndexEntry({
      state,
      indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
      conversationId: next.conversationId,
    });
    return;
  }
  await upsertIndexEntry({
    state,
    indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
    conversationId: next.conversationId,
    score: next.execution.updatedAtMs ?? next.updatedAtMs,
  });
}

function assertSameConversationDestination(args: {
  conversationId: string;
  current: Destination | undefined;
  next: Destination;
}): void {
  if (!args.current || sameDestination(args.current, args.next)) {
    return;
  }
  throw new Error(
    `Conversation destination changed for ${args.conversationId}`,
  );
}

function assertSameOptionalConversationDestination(args: {
  conversationId: string;
  current: Destination | undefined;
  next: Destination | undefined;
}): void {
  // Next without destination keeps the conversation destination. First set is
  // allowed when current is empty. Only a conflicting next is an error.
  if (!args.next || !args.current) {
    return;
  }
  if (sameDestination(args.current, args.next)) {
    return;
  }
  throw new Error(
    `Conversation destination changed for ${args.conversationId}`,
  );
}

function conversationWorkState(
  conversation: ConversationExecutionState,
): ConversationWorkState {
  const lease = conversation.execution.lease;
  return {
    ...conversation,
    lastEnqueuedAtMs: conversation.execution.lastEnqueuedAtMs,
    ...(lease
      ? {
          lease: {
            acquiredAtMs: lease.acquiredAtMs,
            lastCheckInAtMs: lease.lastCheckInAtMs,
            leaseExpiresAtMs: lease.expiresAtMs,
            leaseToken: lease.token,
          },
        }
      : undefined),
    messages: pendingMessages(conversation),
    needsRun: hasRunnableWork(conversation),
  };
}

/** Return a persisted conversation record, if one exists. */
export async function getConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<ConversationExecutionState | undefined> {
  const state = await getConnectedState(args.state);
  return await readConversation(state, args.conversationId);
}

/** Return a persisted conversation work record, if one exists. */
export async function getConversationWorkState(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<ConversationWorkState | undefined> {
  const conversation = await getConversation(args);
  return conversation ? conversationWorkState(conversation) : undefined;
}

/**
 * Return the persisted work records of several Conversations in one state
 * read. A Conversation with no record has no entry.
 */
export async function getConversationWorkStates(
  conversationIds: readonly string[],
): Promise<Map<string, ConversationWorkState>> {
  const state = await getConnectedState();
  const values = await getStateValues(
    state,
    conversationIds.map(conversationKey),
  );
  const workStates = new Map<string, ConversationWorkState>();
  for (const [index, conversationId] of conversationIds.entries()) {
    const conversation = conversationFromValue(conversationId, values[index]);
    if (conversation) {
      workStates.set(conversationId, conversationWorkState(conversation));
    }
  }
  return workStates;
}

/** Count mailbox messages that have not yet reached the conversation event log. */
export function countPendingConversationMessages(
  conversation: ConversationExecutionState,
): number {
  return pendingMessages(conversation).length;
}

/** Return whether a conversation has pending or resumable execution work. */
export function hasRunnableConversationWork(
  conversation: ConversationExecutionState,
): boolean {
  return hasRunnableWork(conversation);
}

/** The fields that claim an inbound message id for its Conversation. */
export type InboundMessageClaim = Pick<
  InboundMessage,
  "conversationId" | "destination" | "inboundMessageId" | "source"
>;

/** Read the Conversation of an inbound message, or a new one for it. */
async function readInboundConversation(
  state: StateAdapter,
  message: InboundMessageClaim,
  nowMs: number,
): Promise<ConversationExecutionState> {
  const existing = await readConversation(state, message.conversationId);
  if (!existing) {
    return emptyConversation({
      conversationId: message.conversationId,
      destination: message.destination,
      nowMs,
      source: message.source,
    });
  }
  assertSameOptionalConversationDestination({
    conversationId: message.conversationId,
    current: existing.destination,
    next: message.destination,
  });
  return existing;
}

async function appendInboundMessageWithAdmission(args: {
  exclusive: boolean;
  message: InboundMessage;
  nowMs?: number;
  renderText?: RenderInboundText;
  state?: StateAdapter;
}): Promise<AppendExclusiveInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(
    { conversationId: args.message.conversationId, state: args.state },
    async (state, lock) => {
      const current = await readInboundConversation(state, args.message, nowMs);
      const existingPending = current.execution.pendingMessages.some(
        (message) => message.inboundMessageId === args.message.inboundMessageId,
      );
      const existingMessage = current.execution.inboundMessageIds.includes(
        args.message.inboundMessageId,
      );
      if (existingMessage) {
        if (!existingPending) {
          return { status: "duplicate" };
        }
        const nextStatus =
          current.execution.status === "idle"
            ? "pending"
            : current.execution.status;
        await writeConversation(
          state,
          lock,
          withExecutionUpdate(
            current,
            {
              ...current.execution,
              status: nextStatus,
              pendingMessages: current.execution.pendingMessages.map(
                (message) =>
                  message.inboundMessageId === args.message.inboundMessageId
                    ? upgradedPendingMessage(message, args.message)
                    : message,
              ),
            },
            nowMs,
          ),
        );
        return { status: "duplicate" };
      }
      if (args.exclusive && hasRunnableWork(current)) {
        return { status: "active" };
      }
      const text = args.renderText
        ? await args.renderText(
            current.execution.inboundMessageIds,
            current.execution.messageSenders ?? {},
          )
        : args.message.input.text;
      if (text === undefined) {
        // Record the id, so a repeat append of the dropped message is a
        // duplicate too.
        await writeConversation(
          state,
          lock,
          withExecutionUpdate(
            current,
            {
              ...current.execution,
              inboundMessageIds: [
                ...current.execution.inboundMessageIds,
                args.message.inboundMessageId,
              ],
              messageSenders: withMessageSenders(
                current.execution.messageSenders,
                [args.message],
              ),
            },
            nowMs,
          ),
        );
        return { status: "duplicate" };
      }
      const message: InboundMessage = {
        ...args.message,
        input: { ...args.message.input, text },
      };

      let status: ExecutionStatus;
      if (current.execution.lease) {
        status = current.execution.status === "running" ? "running" : "paused";
      } else if (
        current.execution.status === "paused" &&
        args.message.delivery === "defer"
      ) {
        status = "paused";
      } else {
        status = "pending";
      }
      const next: ConversationExecutionState = {
        ...current,
        destination: current.destination ?? args.message.destination,
        source: current.source ?? args.message.source,
        lastActivityAtMs: nowMs,
      };
      await writeConversation(
        state,
        lock,
        withExecutionUpdate(
          next,
          {
            ...current.execution,
            status,
            inboundMessageIds: [
              ...current.execution.inboundMessageIds,
              args.message.inboundMessageId,
            ],
            pendingMessages: [
              ...current.execution.pendingMessages,
              message,
            ].sort(compareMessages),
          },
          nowMs,
        ),
      );
      return { status: "appended" };
    },
  );
}

/**
 * Ends what a conversation owns before its work stops for good. It runs
 * under the conversation lock, before the stop is written.
 */
export type BeforeWorkStops = (
  conversationId: string,
  inboundMessageIds: readonly string[],
) => Promise<void>;

/**
 * Render the text of one inbound message from the ids that already reached
 * its mailbox and their sender fields. It runs under the mailbox lock, so two
 * appends that depend on each other see each other. Undefined drops the
 * message for good: its id is recorded and nothing is appended, as for a
 * duplicate.
 */
export type RenderInboundText = (
  inboundMessageIds: readonly string[],
  messageSenders: Readonly<InboundMessageSenders>,
) => Promise<string | undefined>;

/** Persist one inbound message idempotently in its conversation mailbox. */
export async function appendInboundMessage(args: {
  message: InboundMessage;
  nowMs?: number;
  renderText?: RenderInboundText;
  state?: StateAdapter;
}): Promise<AppendInboundMessageResult> {
  const result = await appendInboundMessageWithAdmission({
    ...args,
    exclusive: false,
  });
  if (result.status === "active") {
    throw new Error("Non-exclusive mailbox append returned active");
  }
  return result;
}

/**
 * Record an inbound message id without adding the message to the mailbox.
 * Ingress uses it for input that it handles itself, such as a Slack `stop`.
 * The id is a duplicate after that, for this claim and for the mailbox, so
 * one message is handled once. A claim that fails after its duplicate check
 * is released, so a redelivery can claim again. A claim that fails before
 * it keeps an id that an earlier delivery saved.
 */
export async function claimInboundMessage(args: {
  message: InboundMessageClaim;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<ClaimInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  // Set once the duplicate check passes. From then on a throw may come after
  // the claim landed, such as from an index write or the lock release, so
  // only then is the claim this call's to release.
  let claimWritten = false;
  try {
    return await withConversationMutation(
      { conversationId: args.message.conversationId, state: args.state },
      async (state, lock) => {
        const current = await readInboundConversation(
          state,
          args.message,
          nowMs,
        );
        if (
          current.execution.inboundMessageIds.includes(
            args.message.inboundMessageId,
          )
        ) {
          return { status: "duplicate" };
        }
        claimWritten = true;
        await writeConversation(
          state,
          lock,
          withExecutionUpdate(
            {
              ...current,
              destination: current.destination ?? args.message.destination,
              source: current.source ?? args.message.source,
              lastActivityAtMs: nowMs,
            },
            {
              ...current.execution,
              inboundMessageIds: [
                ...current.execution.inboundMessageIds,
                args.message.inboundMessageId,
              ],
            },
            nowMs,
          ),
        );
        return { status: "claimed" };
      },
    );
  } catch (error) {
    if (claimWritten) {
      await releaseInboundMessage(args);
    }
    throw error;
  }
}

/**
 * Release a claim from `claimInboundMessage`, so a redelivery of the message
 * is new again. A message that waits in the mailbox keeps its id. It runs
 * after a failure, so a failed release is logged and not thrown, and the
 * error that caused it wins.
 */
export async function releaseInboundMessage(args: {
  message: InboundMessageClaim;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? now();
  const id = args.message.inboundMessageId;
  try {
    await withConversationMutation(
      { conversationId: args.message.conversationId, state: args.state },
      async (state, lock) => {
        const current = await readInboundConversation(
          state,
          args.message,
          nowMs,
        );
        if (
          !current.execution.inboundMessageIds.includes(id) ||
          current.execution.pendingMessages.some(
            (message) => message.inboundMessageId === id,
          )
        ) {
          return;
        }
        await writeConversation(
          state,
          lock,
          withExecutionUpdate(
            current,
            {
              ...current.execution,
              inboundMessageIds: current.execution.inboundMessageIds.filter(
                (inboundMessageId) => inboundMessageId !== id,
              ),
            },
            nowMs,
          ),
        );
      },
    );
  } catch (error) {
    logException(error, "conversation.stop.release.failed");
  }
}

/** Append only when the Conversation has no other runnable work. */
export async function appendExclusiveInboundMessage(args: {
  message: InboundMessage;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<AppendExclusiveInboundMessageResult> {
  return await appendInboundMessageWithAdmission({
    ...args,
    exclusive: true,
  });
}

/** Mark a conversation runnable when there is no new mailbox message. */
export async function requestConversationWork(args: {
  conversationId: string;
  destination?: Destination;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<RequestConversationWorkResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const existing = await readConversation(state, args.conversationId);
    if (existing) {
      assertSameOptionalConversationDestination({
        conversationId: args.conversationId,
        current: existing.destination,
        next: args.destination,
      });
    }
    const current =
      existing ??
      emptyConversation({
        conversationId: args.conversationId,
        destination: args.destination,
        nowMs,
      });
    const status = current.execution.lease ? "paused" : "pending";
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        {
          ...current,
          destination: current.destination ?? args.destination,
        },
        {
          ...current.execution,
          status,
        },
        nowMs,
      ),
    );
    return { status: existing === undefined ? "created" : "updated" };
  });
}

/** Record visible conversation activity without making the conversation runnable. */
export async function recordConversationActivity(args: {
  activityAtMs?: number;
  channelName?: string;
  conversationId: string;
  destination?: Destination;
  nowMs?: number;
  actor?: StoredSlackActor;
  source?: Source;
  state?: StateAdapter;
  title?: string;
}): Promise<void> {
  const nowMs = args.nowMs ?? now();
  const activityAtMs = args.activityAtMs ?? nowMs;
  await withConversationMutation(args, async (state, lock) => {
    const existing = await readConversation(state, args.conversationId);
    if (existing && args.destination) {
      assertSameConversationDestination({
        conversationId: args.conversationId,
        current: existing.destination,
        next: args.destination,
      });
    }
    const current =
      existing ??
      emptyConversation({
        conversationId: args.conversationId,
        destination: args.destination,
        nowMs,
        source: args.source,
      });
    await writeConversation(state, lock, {
      ...current,
      ...((current.destination ?? args.destination)
        ? { destination: current.destination ?? args.destination }
        : undefined),
      ...((current.source ?? args.source)
        ? { source: current.source ?? args.source }
        : undefined),
      ...((current.channelName ?? args.channelName)
        ? { channelName: current.channelName ?? args.channelName }
        : undefined),
      ...((current.actor ?? args.actor)
        ? { actor: current.actor ?? args.actor }
        : undefined),
      ...((current.title ?? args.title)
        ? { title: current.title ?? args.title }
        : undefined),
      lastActivityAtMs: Math.max(current.lastActivityAtMs, activityAtMs),
      updatedAtMs: nowMs,
      execution: executionWithPendingMessages(
        current.execution,
        current.execution.pendingMessages,
      ),
    });
  });
}

/**
 * Move a Conversation that has no active Run to a new Destination.
 *
 * `move` commits the durable change while this holds the mutation lock, so
 * no inbound Message can join with the old Destination in between. Pending
 * Messages get the new Destination too. A Run that holds the lease or waits
 * to resume keeps its own copy, so this returns `busy` without calling
 * `move`.
 */
export async function moveIdleConversationDestination(args: {
  conversationId: string;
  destination: Destination;
  move: () => Promise<boolean>;
  state?: StateAdapter;
}): Promise<"busy" | "moved" | "not_moved"> {
  return await withConversationMutation(args, async (state, lock) => {
    const existing = await readConversation(state, args.conversationId);
    if (existing && isHeldByRun(existing)) {
      return "busy";
    }
    if (!(await args.move())) return "not_moved";
    if (existing) {
      await writeConversation(state, lock, {
        ...existing,
        destination: args.destination,
        execution: {
          ...existing.execution,
          pendingMessages: existing.execution.pendingMessages.map(
            (message) => ({ ...message, destination: args.destination }),
          ),
        },
      });
    }
    return "moved";
  });
}

function isHeldByRun(conversation: ConversationExecutionState): boolean {
  return (
    conversation.execution.lease !== undefined ||
    conversation.execution.status === "running" ||
    conversation.execution.status === "paused"
  );
}

/**
 * Store one Destination move until the Run that holds the Conversation ends.
 *
 * The first stored move wins: a later call gets it back. With no Run, this
 * stores nothing and returns `idle`, so the caller moves now.
 */
export async function deferConversationMove(args: {
  conversationId: string;
  move: unknown;
  state?: StateAdapter;
}): Promise<{ status: "idle" } | { move: unknown; status: "deferred" }> {
  return await withConversationMutation(args, async (state, lock) => {
    const existing = await readConversation(state, args.conversationId);
    if (!existing || !isHeldByRun(existing)) return { status: "idle" };
    const key = deferredMoveKey(args.conversationId);
    const stored = await state.get(key);
    if (stored !== null) return { move: stored, status: "deferred" };
    await fenceConversationMutation(state, lock, args.conversationId);
    await state.set(key, args.move, JUNIOR_THREAD_STATE_TTL_MS);
    return { move: args.move, status: "deferred" };
  });
}

/**
 * Remove and return the deferred move once no Run holds the Conversation.
 * The caller runs it, and defers it again when a new Run started first.
 */
export async function takeDeferredConversationMove(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<unknown> {
  const key = deferredMoveKey(args.conversationId);
  // Almost every Run ends with no deferred move. Skip the lock for those.
  if ((await (await getConnectedState(args.state)).get(key)) === null) {
    return undefined;
  }
  return await withConversationMutation(args, async (state, lock) => {
    const existing = await readConversation(state, args.conversationId);
    if (existing && isHeldByRun(existing)) return undefined;
    const stored = await state.get(key);
    if (stored === null) return undefined;
    await fenceConversationMutation(state, lock, args.conversationId);
    await state.delete(key);
    return stored;
  });
}

/** Record that a wake-up nudge was accepted for the conversation. */
export async function markConversationWorkEnqueued(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? now();
  await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return;
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs: nowMs,
        },
        nowMs,
      ),
    );
  });
}

/** Clear a wake marker after its queue delivery finds no runnable work. */
export async function clearConsumedConversationWake(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (
      !current ||
      hasRunnableWork(current) ||
      current.execution.lastEnqueuedAtMs === undefined
    ) {
      return false;
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs: undefined,
        },
        nowMs,
      ),
    );
    return true;
  });
}

/** Try to acquire the durable execution lease for one conversation. */
export async function startConversationWork(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<StartConversationWorkResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return { status: "no_work" };
    }
    if (isLeaseActive(current.execution.lease, nowMs)) {
      return {
        status: "active",
        leaseExpiresAtMs: current.execution.lease!.expiresAtMs,
      };
    }
    if (!hasRunnableWork(current)) {
      return { status: "no_work" };
    }

    const lease: Lease = {
      token: randomUUID(),
      acquiredAtMs: nowMs,
      lastCheckInAtMs: nowMs,
      expiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
    };
    const startsNewRun = current.execution.runId === undefined;
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lease,
          status: current.execution.status === "paused" ? "paused" : "running",
          runId: current.execution.runId ?? randomUUID(),
          lastEnqueuedAtMs: undefined,
          retryCount: startsNewRun ? 0 : current.execution.retryCount,
        },
        nowMs,
      ),
    );
    return {
      status: "acquired",
      leaseToken: lease.token,
      leaseExpiresAtMs: lease.expiresAtMs,
    };
  });
}

/** Extend the durable execution lease when the worker checks in. */
export async function checkInConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return false;
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lease: {
            ...current.execution.lease,
            lastCheckInAtMs: nowMs,
            expiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
          },
        },
        nowMs,
      ),
    );
    return true;
  });
}

/**
 * Resolve pending mailbox entries after the caller accepts responsibility.
 *
 * Returning ids acknowledges only that subset; returning nothing acknowledges
 * every pending entry passed to the handler.
 */
export async function drainConversationMailbox(args: {
  conversationId: string;
  handle: (messages: InboundMessage[]) => Promise<readonly string[] | void>;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<{ changed: boolean; messages: InboundMessage[] }> {
  const nowMs = args.nowMs ?? now();
  const pending = await withConversationMutation(args, async (state) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      throw new Error(
        `Conversation lease is not held for ${args.conversationId}`,
      );
    }
    return pendingMessages(current);
  });
  if (pending.length === 0) {
    return { changed: false, messages: [] };
  }

  const result = await args.handle(pending);
  const pendingIds = new Set(
    pending.map((message) => message.inboundMessageId),
  );
  const acknowledgedIds = new Set(
    result ?? pending.map((message) => message.inboundMessageId),
  );
  for (const inboundMessageId of acknowledgedIds) {
    if (!pendingIds.has(inboundMessageId)) {
      throw new Error(
        `Conversation mailbox drain result is not pending for ${args.conversationId}`,
      );
    }
  }
  if (acknowledgedIds.size === 0) {
    return { changed: false, messages: [] };
  }

  await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      throw new Error(
        `Conversation lease is not held for ${args.conversationId}`,
      );
    }
    const pendingMessages = current.execution.pendingMessages.filter(
      (message) => !acknowledgedIds.has(message.inboundMessageId),
    );
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          status:
            current.execution.status === "pending" &&
            pendingMessages.length === 0
              ? "running"
              : current.execution.status,
          lastProgressAtMs: nowMs,
          retryCount: 0,
          pendingMessages,
        },
        nowMs,
      ),
    );
  });
  return {
    changed: true,
    messages: pending.filter((message) =>
      acknowledgedIds.has(message.inboundMessageId),
    ),
  };
}

/** Acknowledge leased mailbox entries after the handler accepts responsibility. */
export async function ackMessages(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  const inboundMessageIds = new Set(args.inboundMessageIds);
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return false;
    }
    if (inboundMessageIds.size === 0) {
      return true;
    }

    const pendingMessages = current.execution.pendingMessages.filter(
      (message) => !inboundMessageIds.has(message.inboundMessageId),
    );
    if (pendingMessages.length === current.execution.pendingMessages.length) {
      return true;
    }

    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastProgressAtMs: nowMs,
          retryCount: 0,
          pendingMessages,
        },
        nowMs,
      ),
    );
    return true;
  });
}

async function readConversationStop(
  state: StateAdapter,
  conversationId: string,
): Promise<ConversationStop | undefined> {
  return normalizeStop(await state.get(conversationStopKey(conversationId)));
}

async function fenceConversationMutation(
  state: StateAdapter,
  lock: Lock,
  conversationId: string,
): Promise<void> {
  if (!(await state.extendLock(lock, CONVERSATION_MUTATION_LOCK_TTL_MS))) {
    throw new ConversationMutationFencedError(conversationId);
  }
}

/** Return whether one Conversation run has a durable stop request. */
export async function hasConversationStop(args: {
  conversationId: string;
  runId: string;
  state?: StateAdapter;
}): Promise<boolean> {
  const state = await getConnectedState(args.state);
  return (
    (await readConversationStop(state, args.conversationId))?.runId ===
    args.runId
  );
}

/** Persist a stop request for the current run without process affinity. */
export async function stopConversationWork(args: {
  conversationId: string;
  nowMs?: number;
  /** Stop only person input sent at or before this time. */
  sentAtOrBeforeMs?: number;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || !hasRunnableWork(current)) {
      return { status: "no_work" };
    }

    const runId = current.execution.runId ?? randomUUID();
    const pendingMessages = current.execution.pendingMessages.filter(
      (message) =>
        isPersonInput(message.source) &&
        (args.sentAtOrBeforeMs === undefined ||
          message.createdAtMs <= args.sentAtOrBeforeMs),
    );
    const inboundMessageIds = pendingMessages.map(
      (message) => message.inboundMessageId,
    );
    if (current.execution.runId === undefined) {
      await writeConversation(
        state,
        lock,
        withExecutionUpdate(current, { ...current.execution, runId }, nowMs),
      );
    }
    await fenceConversationMutation(state, lock, args.conversationId);
    await state.set(
      conversationStopKey(args.conversationId),
      { inboundMessageIds, runId } satisfies ConversationStop,
      JUNIOR_THREAD_STATE_TTL_MS,
    );
    return { runId, status: "requested", pendingMessages };
  });
}

/** Clear one observed stop request and discard older human-facing mailbox work. */
export async function completeConversationStop(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  runId: string;
  state?: StateAdapter;
}): Promise<CompleteConversationStopResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return { status: "lost_lease", removedInboundMessageIds: [] };
    }
    const stop = await readConversationStop(state, args.conversationId);
    if (!stop || stop.runId !== args.runId) {
      return { status: "none", removedInboundMessageIds: [] };
    }

    const stoppedInboundMessageIds = new Set(stop.inboundMessageIds);
    const removedInboundMessageIds: string[] = [];
    const pendingMessages = current.execution.pendingMessages.filter(
      (message) => {
        const shouldStop = stoppedInboundMessageIds.has(
          message.inboundMessageId,
        );
        if (shouldStop) {
          removedInboundMessageIds.push(message.inboundMessageId);
        }
        return !shouldStop;
      },
    );
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs:
            pendingMessages.length === 0
              ? undefined
              : current.execution.lastEnqueuedAtMs,
          pendingMessages,
        },
        nowMs,
      ),
    );
    await fenceConversationMutation(state, lock, args.conversationId);
    await state.delete(conversationStopKey(args.conversationId));
    return { status: "cleared", removedInboundMessageIds };
  });
}

/** Cancel human-facing pending mailbox rows without requiring a worker lease. */
export async function cancelHumanFacingPendingMessages(args: {
  conversationId: string;
  inboundMessageIds?: readonly string[];
  receivedBeforeMs?: number;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<{
  cancelledInboundMessageIds: string[];
  cancelledMessages: InboundMessage[];
}> {
  const requestedIds =
    args.inboundMessageIds === undefined
      ? undefined
      : new Set(args.inboundMessageIds);
  const cancelledMessages = await removePendingMessages(
    args,
    (message) =>
      isPersonInput(message.source) &&
      (requestedIds === undefined ||
        requestedIds.has(message.inboundMessageId)) &&
      (args.receivedBeforeMs === undefined ||
        message.receivedAtMs <= args.receivedBeforeMs),
  );
  return {
    cancelledInboundMessageIds: cancelledMessages.map(
      (message) => message.inboundMessageId,
    ),
    cancelledMessages,
  };
}

/**
 * Drop pending mailbox rows by id without a worker lease, such as unread
 * input that a stop skips. Returns the ids that were dropped.
 */
export async function dropPendingMessages(args: {
  conversationId: string;
  inboundMessageIds: readonly string[];
  nowMs?: number;
  state?: StateAdapter;
}): Promise<string[]> {
  const ids = new Set(args.inboundMessageIds);
  const dropped = await removePendingMessages(args, (message) =>
    ids.has(message.inboundMessageId),
  );
  return dropped.map((message) => message.inboundMessageId);
}

async function removePendingMessages(
  args: { conversationId: string; nowMs?: number; state?: StateAdapter },
  shouldRemove: (message: InboundMessage) => boolean,
): Promise<InboundMessage[]> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return [];
    }
    const removed = current.execution.pendingMessages.filter(shouldRemove);
    if (removed.length === 0) {
      return removed;
    }
    const pendingMessages = current.execution.pendingMessages.filter(
      (message) => !removed.includes(message),
    );
    const becomesIdle =
      current.execution.status === "pending" && pendingMessages.length === 0;

    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs:
            pendingMessages.length === 0
              ? undefined
              : current.execution.lastEnqueuedAtMs,
          pendingMessages,
          retryCount: becomesIdle ? 0 : current.execution.retryCount,
          runId: becomesIdle ? undefined : current.execution.runId,
          status: becomesIdle ? "idle" : current.execution.status,
        },
        nowMs,
      ),
    );
    return removed;
  });
}

/**
 * Mark one author's queued web messages as interrupts without a worker lease.
 * `authorIds` lists every id that names the author.
 *
 * The active Turn drains them at its next model boundary when it belongs to the
 * same author. Otherwise they start the next Turn ahead of deferred input.
 */
export async function steerWebPendingMessages(args: {
  authorIds: readonly string[];
  conversationId: string;
  inboundMessageIds: readonly string[];
  nowMs?: number;
  state?: StateAdapter;
}): Promise<{ steeredInboundMessageIds: string[] }> {
  const nowMs = args.nowMs ?? now();
  const requestedIds = new Set(args.inboundMessageIds);
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return { steeredInboundMessageIds: [] };
    }

    const steeredInboundMessageIds: string[] = [];
    const pendingMessages = current.execution.pendingMessages.map((message) => {
      if (
        message.source !== "web" ||
        message.delivery !== "defer" ||
        message.input.authorId === undefined ||
        !args.authorIds.includes(message.input.authorId) ||
        !requestedIds.has(message.inboundMessageId)
      ) {
        return message;
      }
      steeredInboundMessageIds.push(message.inboundMessageId);
      return { ...message, delivery: "interrupt" as const };
    });
    if (steeredInboundMessageIds.length === 0) {
      return { steeredInboundMessageIds };
    }

    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        { ...current.execution, pendingMessages },
        nowMs,
      ),
    );
    return { steeredInboundMessageIds };
  });
}

/** Mark the leased conversation as needing another queue-delivered slice. */
export async function requestAnotherSlice(args: {
  conversationId: string;
  destination?: Destination;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return false;
    }
    assertSameOptionalConversationDestination({
      conversationId: args.conversationId,
      current: current.destination,
      next: args.destination,
    });
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          status: "paused",
        },
        nowMs,
      ),
    );
    return true;
  });
}

/** Begin a requested turn resume under the worker's existing lease. */
export async function beginConversationResume(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (
      !current ||
      current.execution.lease?.token !== args.leaseToken ||
      current.execution.status !== "paused"
    ) {
      return false;
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          status: "running",
        },
        nowMs,
      ),
    );
    return true;
  });
}

/** Release the durable execution lease without changing completion state. */
export async function releaseConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return false;
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lease: undefined,
          status:
            current.execution.status === "running"
              ? "pending"
              : current.execution.status,
        },
        nowMs,
      ),
    );
    return true;
  });
}

/** Count one failed execution attempt and stop the conversation when retries are exhausted. */
export async function recordConversationRetry(args: {
  beforeWorkStops?: BeforeWorkStops;
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<"lost_lease" | "recorded" | "stopped"> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return "lost_lease";
    }
    const count = (current.execution.retryCount ?? 0) + 1;
    const stopped = count >= CONVERSATION_WORK_MAX_RETRIES;
    if (stopped) {
      // Runs under the lock, as in `clearExpiredConversationLease`. When it
      // throws, the work keeps its lease, so a later attempt or the
      // heartbeat stops it.
      await args.beforeWorkStops?.(
        args.conversationId,
        current.execution.inboundMessageIds,
      );
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs: undefined,
          lease: stopped ? undefined : current.execution.lease,
          retryCount: count,
          pendingMessages: stopped ? [] : current.execution.pendingMessages,
          runId: stopped ? undefined : current.execution.runId,
          status: stopped ? "failed" : "paused",
        },
        nowMs,
      ),
    );
    return stopped ? "stopped" : "recorded";
  });
}

/** Finish a leased conversation and report whether runnable work remains. */
export async function completeConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  madeProgress?: boolean;
  nowMs?: number;
  /** Keep a raced stop runnable after a stop-aware adapter returns. */
  resumeIfStopped?: boolean;
  state?: StateAdapter;
}): Promise<"completed" | "lost_lease" | "pending"> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return "lost_lease";
    }
    const hasPending = pendingMessages(current).length > 0;
    const stopped =
      args.resumeIfStopped === true &&
      (await readConversationStop(state, args.conversationId))?.runId ===
        current.execution.runId;
    const needsRun = current.execution.status === "paused" || stopped;
    const runnable = needsRun || hasPending;
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lease: undefined,
          status: needsRun ? "paused" : hasPending ? "pending" : "idle",
          lastProgressAtMs:
            args.madeProgress === false
              ? current.execution.lastProgressAtMs
              : nowMs,
          retryCount:
            runnable || args.madeProgress === false
              ? current.execution.retryCount
              : 0,
          runId: runnable ? current.execution.runId : undefined,
        },
        nowMs,
      ),
    );
    return runnable ? "pending" : "completed";
  });
}

/** Failure outcome: `lost_lease` (another owner took over), `recorded` (retry counted), or `skipped` (durable progress was made). */
export interface AttemptFailure {
  pendingCount: number;
  deadLetteredMessages: InboundMessage[];
  retryCount: number;
  status: "lost_lease" | "recorded" | "skipped";
}

/**
 * Record one failed execution attempt for pending messages, dead-lettering
 * the conversation when its retry budget or the legacy message delivery limit
 * is exhausted.
 *
 * Retries are counted only when the run made no durable progress: if any
 * attempted message left the mailbox, the remaining pending entries may be
 * deliberate deferrals and are left untouched. Consumed message ids stay in
 * `inboundMessageIds` so source retries remain duplicates.
 */
export async function recordAttemptFailure(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<AttemptFailure> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return {
        status: "lost_lease",
        pendingCount: 0,
        deadLetteredMessages: [],
        retryCount: 0,
      };
    }
    const pendingIds = new Set(
      current.execution.pendingMessages.map(
        (message) => message.inboundMessageId,
      ),
    );
    if (
      args.inboundMessageIds.length === 0 ||
      args.inboundMessageIds.some((id) => !pendingIds.has(id))
    ) {
      return {
        status: "skipped",
        pendingCount: current.execution.pendingMessages.length,
        deadLetteredMessages: [],
        retryCount: current.execution.retryCount ?? 0,
      };
    }

    const retryCount = (current.execution.retryCount ?? 0) + 1;
    const retriesExhausted = retryCount >= CONVERSATION_WORK_MAX_RETRIES;
    const attemptedIds = new Set(args.inboundMessageIds);
    const deadLetteredMessages: InboundMessage[] = [];
    const pendingMessages: InboundMessage[] = [];
    for (const message of current.execution.pendingMessages) {
      if (!attemptedIds.has(message.inboundMessageId)) {
        if (retriesExhausted) {
          deadLetteredMessages.push(message);
        } else {
          pendingMessages.push(message);
        }
        continue;
      }
      const attempted = {
        ...message,
        attemptCount: (message.attemptCount ?? 0) + 1,
      };
      if (
        retriesExhausted ||
        attempted.attemptCount >= CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS
      ) {
        deadLetteredMessages.push(attempted);
        continue;
      }
      pendingMessages.push(attempted);
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          retryCount,
          pendingMessages,
        },
        nowMs,
      ),
    );
    return {
      status: "recorded",
      pendingCount: pendingMessages.length,
      deadLetteredMessages,
      retryCount,
    };
  });
}

/** Record a terminal failure completion for a leased conversation. */
export async function deadLetterAttempt(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<"failed" | "lost_lease" | "pending"> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || current.execution.lease?.token !== args.leaseToken) {
      return "lost_lease";
    }
    const runnable = pendingMessages(current).length > 0;
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lease: undefined,
          status: runnable ? "pending" : "failed",
          runId: runnable ? current.execution.runId : undefined,
        },
        nowMs,
      ),
    );
    return runnable ? "pending" : "failed";
  });
}

/** Recover an expired lease, consuming the retry budget under the mutation lock. */
export async function clearExpiredConversationLease(args: {
  beforeWorkStops?: BeforeWorkStops;
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<"not_expired" | "requeued" | "stopped"> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (
      !current?.execution.lease ||
      current.execution.lease.expiresAtMs > nowMs
    ) {
      return "not_expired";
    }
    const retryCount = (current.execution.retryCount ?? 0) + 1;
    const stopped = retryCount >= CONVERSATION_WORK_MAX_RETRIES;
    if (stopped) {
      // A lost worker runs no failure path. This runs under the lock, so the
      // worker cannot renew the lease and no message can reach the mailbox
      // after it. When it throws, the lease stays expired and the next
      // heartbeat runs it again.
      await args.beforeWorkStops?.(
        args.conversationId,
        current.execution.inboundMessageIds,
      );
    }
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          lastEnqueuedAtMs: undefined,
          lease: undefined,
          retryCount,
          pendingMessages: stopped ? [] : current.execution.pendingMessages,
          runId: stopped ? undefined : current.execution.runId,
          status: stopped ? "failed" : "paused",
        },
        nowMs,
      ),
    );
    return stopped ? "stopped" : "requeued";
  });
}

/** Delete one conversation mailbox and all of its index entries. */
export async function deleteConversationState(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<void> {
  await withConversationMutation(args, async (state) => {
    await state.delete(conversationKey(args.conversationId));
    await state.delete(conversationStopKey(args.conversationId));
    await removeIndexEntry({
      state,
      indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
      conversationId: args.conversationId,
    });
    await removeIndexEntry({
      state,
      indexKey: CONVERSATION_BY_ACTIVITY_INDEX_KEY,
      conversationId: args.conversationId,
    });
  });
}

/**
 * Remove a stale active index entry. This holds the mutation lock and reads
 * the record again, so it cannot remove the entry of work that a writer just
 * made runnable. A missing or invalid record can never run again.
 */
export async function pruneActiveConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<void> {
  await withConversationMutation(args, async (state) => {
    let current: ConversationExecutionState | undefined;
    try {
      current = await readConversation(state, args.conversationId);
    } catch (error) {
      if (!(error instanceof InvalidConversationRecordError)) {
        throw error;
      }
    }
    if (current && hasRunnableWork(current)) {
      return;
    }
    await removeIndexEntry({
      state,
      indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
      conversationId: args.conversationId,
    });
  });
}

/** List active conversation ids by oldest execution update first. */
export async function listActiveConversationIds(
  args: {
    limit?: number;
    staleBeforeMs?: number;
    state?: StateAdapter;
  } = {},
): Promise<string[]> {
  const state = await getConnectedState(args.state);
  const index = await getConversationIndexStore(state);
  const entries = await index.list({
    indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
    limit: args.limit,
    order: "asc",
    scoreMax: args.staleBeforeMs,
  });
  return entries.map((entry) => entry.conversationId);
}

/** List retained conversations by newest visible activity first. */
export async function listConversationsByActivity(
  args: {
    limit?: number;
    offset?: number;
    state?: StateAdapter;
  } = {},
): Promise<ConversationExecutionState[]> {
  const state = await getConnectedState(args.state);
  const index = await getConversationIndexStore(state);
  const entries = await index.list({
    indexKey: CONVERSATION_BY_ACTIVITY_INDEX_KEY,
    limit: args.limit ?? CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH,
    offset: args.offset,
    order: "desc",
  });
  const conversations: ConversationExecutionState[] = [];
  for (const entry of entries) {
    try {
      const conversation = await readConversation(state, entry.conversationId);
      if (conversation) {
        conversations.push(conversation);
      }
    } catch (error) {
      if (!(error instanceof InvalidConversationRecordError)) {
        throw error;
      }
      await removeIndexEntry({
        state,
        indexKey: CONVERSATION_BY_ACTIVITY_INDEX_KEY,
        conversationId: entry.conversationId,
      });
    }
  }
  return conversations;
}
