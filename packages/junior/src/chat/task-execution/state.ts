/**
 * Expiring conversation mailbox and execution index store.
 *
 * The conversation record owns pending inbound work, execution status, and the
 * lease. `conversation:active` feeds heartbeat recovery and contains every
 * non-idle conversation until the lease/status path makes it idle.
 * `conversation:by-activity` supports legacy SQL import only; SQL owns durable
 * conversation metadata in configured runtime.
 */
import { randomUUID } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import { destinationSchema, type Destination } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
import { getChatConfig } from "@/chat/config";
import { parseDestination, sameDestination } from "@/chat/destination";
import { parseStoredSlackActor, type StoredSlackActor } from "@/chat/actor";
import {
  getDefaultRedisStateAdapterFor,
  getStateAdapter,
} from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

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
  "resource_event",
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
    metadata: z.record(z.string(), z.unknown()).optional(),
    text: z.string(),
  })
  .strict()
  .refine((input) => input.text.trim() || input.attachments?.length, {
    message: "agent input requires text or attachments",
  });

export type AgentInput = z.output<typeof agentInputSchema>;

/** Durable delivery modes for pending inbound mailbox work. */
export const inboundMessageDeliverySchema = z.enum(["defer", "interrupt"]);

/** Whether this turn also publishes assistant output to the conversation destination. */
export const publishExternallySchema = z.boolean();

export type InboundMessageDelivery = z.output<
  typeof inboundMessageDeliverySchema
>;

/** Canonical durable mailbox entry owned by task execution. */
export const inboundMessageSchema = z
  .object({
    attemptCount: z.number().finite().optional(),
    conversationId: z.string().refine((value) => value.trim().length > 0),
    createdAtMs: z.number().finite(),
    delivery: inboundMessageDeliverySchema,
    destination: destinationSchema.optional(),
    inboundMessageId: z.string().refine((value) => value.trim().length > 0),
    injectedAtMs: z.number().finite().optional(),
    input: agentInputSchema,
    receivedAtMs: z.number().finite(),
    publishExternally: publishExternallySchema,
    source: inboundMessageSourceSchema,
  })
  .strict();

export type InboundMessage = z.output<typeof inboundMessageSchema>;

export interface Lease {
  acquiredAtMs: number;
  expiresAtMs: number;
  lastCheckInAtMs: number;
  token: string;
}

/** Durable request to stop the current Conversation run. */
export interface ConversationStop {
  inboundMessageIds: string[];
  runId: string;
}

export interface ConversationExecution {
  inboundMessageIds: string[];
  lastCheckpointAtMs?: number;
  lastEnqueuedAtMs?: number;
  lastProgressAtMs?: number;
  retryCount?: number;
  lease?: Lease;
  pendingCount: number;
  pendingMessages: InboundMessage[];
  runId?: string;
  status: ExecutionStatus;
  stop?: ConversationStop;
  updatedAtMs?: number;
}

export interface Conversation {
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

export interface ConversationWorkState extends Conversation {
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
  | { runId: string; status: "requested" };

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
          ? {}
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
  const parsed = inboundMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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

/** Decode execution state and repair idle records that still own work. */
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
      if (message.injectedAtMs !== undefined) {
        continue;
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

  const lease = normalizeLease(value.lease);
  const runId = toOptionalString(value.runId);
  const normalizedStop = normalizeStop(value.stop);
  const stop = normalizedStop?.runId === runId ? normalizedStop : undefined;
  const normalizedStatus =
    status === "idle" && lease
      ? "running"
      : status === "idle" && pendingMessages.length > 0
        ? "pending"
        : status;

  return {
    status: normalizedStatus,
    inboundMessageIds: uniqueStrings([
      ...inboundMessageIds,
      ...pendingMessages.map((message) => message.inboundMessageId),
    ]),
    pendingCount: pendingMessages.length,
    pendingMessages,
    lease,
    lastCheckpointAtMs: toOptionalNumber(value.lastCheckpointAtMs),
    lastEnqueuedAtMs: toOptionalNumber(value.lastEnqueuedAtMs),
    lastProgressAtMs: toOptionalNumber(value.lastProgressAtMs),
    retryCount: toOptionalNumber(value.retryCount),
    runId,
    stop,
    updatedAtMs: toOptionalNumber(value.updatedAtMs),
  };
}

/** Decode current conversation records. */
function normalizeConversation(
  conversationId: string,
  value: unknown,
): Conversation | undefined {
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
  if (
    execution.pendingMessages.length > 0 &&
    execution.pendingMessages.some((message) =>
      message.destination
        ? !destination || !sameDestination(message.destination, destination)
        : Boolean(destination),
    )
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
    ...(destination ? { destination } : {}),
    ...(toOptionalString(value.title)
      ? { title: toOptionalString(value.title) }
      : {}),
    ...(toOptionalString(value.channelName)
      ? { channelName: toOptionalString(value.channelName) }
      : {}),
    ...(normalizeActor(value.actor)
      ? { actor: normalizeActor(value.actor) }
      : {}),
    ...(normalizeSource(value.source)
      ? { source: normalizeSource(value.source) }
      : {}),
  };
}

function emptyConversation(args: {
  conversationId: string;
  destination?: Destination;
  nowMs: number;
  source?: Source;
}): Conversation {
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    conversationId: args.conversationId,
    createdAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.source ? { source: args.source } : {}),
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

function pendingMessages(conversation: Conversation): InboundMessage[] {
  return [...conversation.execution.pendingMessages].sort(compareMessages);
}

// Failed executions are terminal for reporting, but pending messages still keep
// them runnable through hasRunnableWork.
function isRunnableStatus(status: ExecutionStatus): boolean {
  return status !== "failed" && status !== "idle";
}

function hasRunnableWork(conversation: Conversation): boolean {
  return (
    isRunnableStatus(conversation.execution.status) ||
    pendingMessages(conversation).length > 0
  );
}

function executionWithPendingMessages(
  execution: ConversationExecution,
  pending: InboundMessage[],
): ConversationExecution {
  const pendingMessages = [...pending].sort(compareMessages);
  const status =
    execution.status === "idle" && execution.lease
      ? "running"
      : execution.status === "idle" && pendingMessages.length > 0
        ? "pending"
        : execution.status;
  return {
    ...execution,
    status,
    inboundMessageIds: uniqueStrings([
      ...execution.inboundMessageIds,
      ...pendingMessages.map((message) => message.inboundMessageId),
    ]),
    pendingMessages,
    pendingCount: pendingMessages.length,
  };
}

function withExecutionUpdate(
  conversation: Conversation,
  execution: ConversationExecution,
  nowMs: number,
): Conversation {
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
    const score =
      typeof values[index + 1] === "number"
        ? values[index + 1]
        : Number(values[index + 1]);
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
): Promise<Conversation | undefined> {
  const raw = await state.get(conversationKey(conversationId));
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
  conversation: Conversation,
): Promise<void> {
  const execution = executionWithPendingMessages(
    conversation.execution,
    conversation.execution.pendingMessages,
  );
  const next: Conversation = {
    ...conversation,
    execution,
  };
  const fenced = await state.extendLock(
    lock,
    CONVERSATION_MUTATION_LOCK_TTL_MS,
  );
  if (!fenced) {
    throw new ConversationMutationFencedError(next.conversationId);
  }
  await state.set(
    conversationKey(next.conversationId),
    next,
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
  if (!args.current && !args.next) {
    return;
  }
  if (args.current && args.next && sameDestination(args.current, args.next)) {
    return;
  }
  throw new Error(
    `Conversation destination changed for ${args.conversationId}`,
  );
}

function conversationWorkState(
  conversation: Conversation,
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
      : {}),
    messages: pendingMessages(conversation),
    needsRun: hasRunnableWork(conversation),
  };
}

/** Return a persisted conversation record, if one exists. */
export async function getConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<Conversation | undefined> {
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

/** Count mailbox messages that have not yet reached the conversation event log. */
export function countPendingConversationMessages(
  conversation: Conversation,
): number {
  return pendingMessages(conversation).length;
}

/** Return whether a conversation has pending or resumable execution work. */
export function hasRunnableConversationWork(
  conversation: Conversation,
): boolean {
  return hasRunnableWork(conversation);
}

async function appendInboundMessageWithAdmission(args: {
  exclusive: boolean;
  message: InboundMessage;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<AppendExclusiveInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(
    { conversationId: args.message.conversationId, state: args.state },
    async (state, lock) => {
      const existing = await readConversation(
        state,
        args.message.conversationId,
      );
      const current =
        existing ??
        emptyConversation({
          conversationId: args.message.conversationId,
          destination: args.message.destination,
          nowMs,
          source: args.message.source,
        });
      if (existing) {
        assertSameOptionalConversationDestination({
          conversationId: args.message.conversationId,
          current: current.destination,
          next: args.message.destination,
        });
      }
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

      const status =
        current.execution.lease && current.execution.status === "running"
          ? "running"
          : current.execution.lease
            ? "paused"
            : "pending";
      const next: Conversation = {
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
              args.message,
            ].sort(compareMessages),
          },
          nowMs,
        ),
      );
      return { status: "appended" };
    },
  );
}

/** Persist one inbound message idempotently in its conversation mailbox. */
export async function appendInboundMessage(args: {
  message: InboundMessage;
  nowMs?: number;
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
        : {}),
      ...((current.source ?? args.source)
        ? { source: current.source ?? args.source }
        : {}),
      ...((current.channelName ?? args.channelName)
        ? { channelName: current.channelName ?? args.channelName }
        : {}),
      ...((current.actor ?? args.actor)
        ? { actor: current.actor ?? args.actor }
        : {}),
      ...((current.title ?? args.title)
        ? { title: current.title ?? args.title }
        : {}),
      lastActivityAtMs: Math.max(current.lastActivityAtMs, activityAtMs),
      updatedAtMs: nowMs,
      execution: executionWithPendingMessages(
        current.execution,
        current.execution.pendingMessages,
      ),
    });
  });
}

/** Store task-execution metadata for legacy SQL import. */
export async function recordConversationExecution(args: {
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: {
    lastCheckpointAtMs?: number;
    lastEnqueuedAtMs?: number;
    runId?: string;
    status: ExecutionStatus;
    updatedAtMs?: number;
  };
  lastActivityAtMs: number;
  actor?: StoredSlackActor;
  source?: Source;
  state?: StateAdapter;
  title?: string;
  updatedAtMs: number;
}): Promise<void> {
  const nowMs = args.updatedAtMs;
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
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        {
          ...current,
          ...((current.destination ?? args.destination)
            ? { destination: current.destination ?? args.destination }
            : {}),
          ...((current.source ?? args.source)
            ? { source: current.source ?? args.source }
            : {}),
          ...((current.channelName ?? args.channelName)
            ? { channelName: current.channelName ?? args.channelName }
            : {}),
          ...((current.actor ?? args.actor)
            ? { actor: current.actor ?? args.actor }
            : {}),
          ...((current.title ?? args.title)
            ? { title: current.title ?? args.title }
            : {}),
          createdAtMs: Math.min(current.createdAtMs, args.createdAtMs),
          lastActivityAtMs: Math.max(
            current.lastActivityAtMs,
            args.lastActivityAtMs,
          ),
        },
        {
          ...current.execution,
          ...args.execution,
        },
        nowMs,
      ),
    );
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

function isHumanFacingMessage(message: InboundMessage): boolean {
  return message.source === "web" || message.source === "slack";
}

/** Persist a stop request for the current run without process affinity. */
export async function stopConversationWork(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<StopConversationWorkResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current || !hasRunnableWork(current)) {
      return { status: "no_work" };
    }

    const runId = current.execution.runId ?? randomUUID();
    const inboundMessageIds = current.execution.pendingMessages
      .filter(isHumanFacingMessage)
      .map((message) => message.inboundMessageId);
    await writeConversation(
      state,
      lock,
      withExecutionUpdate(
        current,
        {
          ...current.execution,
          runId,
          stop: { inboundMessageIds, runId },
        },
        nowMs,
      ),
    );
    return { runId, status: "requested" };
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
    const stop = current.execution.stop;
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
          stop: undefined,
        },
        nowMs,
      ),
    );
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
}): Promise<{ cancelledInboundMessageIds: string[] }> {
  const nowMs = args.nowMs ?? now();
  const requestedIds =
    args.inboundMessageIds === undefined
      ? undefined
      : new Set(args.inboundMessageIds);
  return await withConversationMutation(args, async (state, lock) => {
    const current = await readConversation(state, args.conversationId);
    if (!current) {
      return { cancelledInboundMessageIds: [] };
    }

    const cancelledInboundMessageIds: string[] = [];
    const pendingMessages: InboundMessage[] = [];
    for (const message of current.execution.pendingMessages) {
      const isRequested =
        requestedIds === undefined ||
        requestedIds.has(message.inboundMessageId);
      const isInSnapshot =
        args.receivedBeforeMs === undefined ||
        message.receivedAtMs <= args.receivedBeforeMs;
      if (isHumanFacingMessage(message) && isRequested && isInSnapshot) {
        cancelledInboundMessageIds.push(message.inboundMessageId);
        continue;
      }
      pendingMessages.push(message);
    }

    if (cancelledInboundMessageIds.length === 0) {
      return { cancelledInboundMessageIds };
    }

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
          stop: becomesIdle ? undefined : current.execution.stop,
        },
        nowMs,
      ),
    );

    return { cancelledInboundMessageIds };
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
          stop: stopped ? undefined : current.execution.stop,
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
    const needsRun =
      current.execution.status === "paused" ||
      (args.resumeIfStopped === true && current.execution.stop !== undefined);
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
          stop: runnable ? current.execution.stop : undefined,
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
          stop: runnable ? current.execution.stop : undefined,
        },
        nowMs,
      ),
    );
    return runnable ? "pending" : "failed";
  });
}

/** Recover an expired lease, consuming the retry budget under the mutation lock. */
export async function clearExpiredConversationLease(args: {
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
          stop: stopped ? undefined : current.execution.stop,
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

/** Remove one conversation from the active index after it is missing or idle. */
export async function removeActiveConversation(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<void> {
  const state = await getConnectedState(args.state);
  await removeIndexEntry({
    state,
    indexKey: CONVERSATION_ACTIVE_INDEX_KEY,
    conversationId: args.conversationId,
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
): Promise<Conversation[]> {
  const state = await getConnectedState(args.state);
  const index = await getConversationIndexStore(state);
  const entries = await index.list({
    indexKey: CONVERSATION_BY_ACTIVITY_INDEX_KEY,
    limit: args.limit ?? CONVERSATION_ACTIVITY_INDEX_MAX_LENGTH,
    offset: args.offset,
    order: "desc",
  });
  const conversations: Conversation[] = [];
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
