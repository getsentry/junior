import { randomUUID } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";
import { parseDestination, sameDestination } from "@/chat/destination";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import type { ConversationWorkQueue } from "./queue";

const CONVERSATION_WORK_PREFIX = "junior:conversation-work";
const CONVERSATION_WORK_SCHEMA_VERSION = 1;
const CONVERSATION_WORK_INDEX_MAX_LENGTH = 10_000;
const CONVERSATION_WORK_INDEX_LOCK_TTL_MS = 10_000;
const CONVERSATION_WORK_INDEX_LOCK_WAIT_MS = 2_000;
const CONVERSATION_WORK_INDEX_LOCK_RETRY_MS = 25;
const CONVERSATION_WORK_MUTATION_LOCK_TTL_MS = 10_000;
const CONVERSATION_WORK_MUTATION_WAIT_MS = 10_000;
const CONVERSATION_WORK_MUTATION_RETRY_MS = 25;

export const CONVERSATION_WORK_LEASE_TTL_MS = 90_000;
export const CONVERSATION_WORK_CHECK_IN_INTERVAL_MS = 15_000;
export const CONVERSATION_WORK_STALE_ENQUEUE_MS = 60_000;
export const CONVERSATION_WORK_MAX_CONSECUTIVE_FAILURES = 5;

export type InboundMessageSource = "plugin" | "scheduler" | "slack";

export interface AgentInputMessage {
  attachments?: unknown[];
  authorId?: string;
  metadata?: Record<string, unknown>;
  text: string;
}

export interface InboundMessageRecord {
  conversationId: string;
  createdAtMs: number;
  destination: Destination;
  inboundMessageId: string;
  injectedAtMs?: number;
  input: AgentInputMessage;
  receivedAtMs: number;
  source: InboundMessageSource;
}

export interface ConversationLease {
  acquiredAtMs: number;
  lastCheckInAtMs: number;
  leaseExpiresAtMs: number;
  leaseToken: string;
}

export interface ConversationWorkState {
  consecutiveFailureCount: number;
  conversationId: string;
  destination: Destination;
  lastEnqueuedAtMs?: number;
  lastFailureAtMs?: number;
  lease?: ConversationLease;
  messages: InboundMessageRecord[];
  needsRun: boolean;
  schemaVersion: 1;
  terminallyFailedAtMs?: number;
  updatedAtMs: number;
}

export interface ConversationLeaseAcquired {
  leaseExpiresAtMs: number;
  leaseToken: string;
  status: "acquired";
}

export interface ConversationLeaseActive {
  leaseExpiresAtMs: number;
  status: "active";
}

export interface ConversationLeaseNoWork {
  status: "no_work";
}

export type ConversationLeaseStartResult =
  | ConversationLeaseAcquired
  | ConversationLeaseActive
  | ConversationLeaseNoWork;

export interface AppendInboundMessageResult {
  status: "appended" | "duplicate";
}

export interface AppendAndEnqueueInboundMessageResult extends AppendInboundMessageResult {
  queueMessageId?: string;
}

export interface RequestConversationWorkResult {
  status: "created" | "updated";
}

function duplicateInboundNudgeIdempotencyKey(
  message: InboundMessageRecord,
  nowMs: number,
): string {
  return `duplicate:${message.conversationId}:${message.inboundMessageId}:${nowMs}`;
}

function hasRecentEnqueueMarker(
  state: ConversationWorkState,
  nowMs: number,
): boolean {
  return (
    typeof state.lastEnqueuedAtMs === "number" &&
    state.lastEnqueuedAtMs + CONVERSATION_WORK_STALE_ENQUEUE_MS > nowMs
  );
}

function stateKey(conversationId: string): string {
  return `${CONVERSATION_WORK_PREFIX}:state:${conversationId}`;
}

function indexKey(): string {
  return `${CONVERSATION_WORK_PREFIX}:index`;
}

function indexLockKey(): string {
  return `${CONVERSATION_WORK_PREFIX}:index:lock`;
}

function mutationLockKey(conversationId: string): string {
  return `${CONVERSATION_WORK_PREFIX}:mutation:${conversationId}`;
}

function now(): number {
  return Date.now();
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => {
        return typeof value === "string" && value.trim().length > 0;
      }),
    ),
  ];
}

function compareMessages(
  left: InboundMessageRecord,
  right: InboundMessageRecord,
): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function normalizeSource(value: unknown): InboundMessageSource | undefined {
  if (value === "plugin" || value === "scheduler" || value === "slack") {
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

function normalizeInput(value: unknown): AgentInputMessage | undefined {
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

function normalizeMessage(value: unknown): InboundMessageRecord | undefined {
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

function normalizeLease(value: unknown): ConversationLease | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const leaseToken = toOptionalString(value.leaseToken);
  const acquiredAtMs = toOptionalNumber(value.acquiredAtMs);
  const lastCheckInAtMs = toOptionalNumber(value.lastCheckInAtMs);
  const leaseExpiresAtMs = toOptionalNumber(value.leaseExpiresAtMs);
  if (
    !leaseToken ||
    typeof acquiredAtMs !== "number" ||
    typeof lastCheckInAtMs !== "number" ||
    typeof leaseExpiresAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    leaseToken,
    acquiredAtMs,
    lastCheckInAtMs,
    leaseExpiresAtMs,
  };
}

function normalizeWorkState(
  conversationId: string,
  value: unknown,
): ConversationWorkState | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CONVERSATION_WORK_SCHEMA_VERSION
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
  const messages = Array.isArray(value.messages)
    ? value.messages
        .map(normalizeMessage)
        .filter((message): message is InboundMessageRecord => Boolean(message))
        .filter((message) => message.conversationId === conversationId)
        .sort(compareMessages)
    : [];
  return {
    schemaVersion: CONVERSATION_WORK_SCHEMA_VERSION,
    conversationId,
    destination,
    messages,
    needsRun: value.needsRun === true,
    updatedAtMs,
    consecutiveFailureCount:
      toOptionalNumber(value.consecutiveFailureCount) ?? 0,
    lastEnqueuedAtMs: toOptionalNumber(value.lastEnqueuedAtMs),
    lastFailureAtMs: toOptionalNumber(value.lastFailureAtMs),
    lease: normalizeLease(value.lease),
    terminallyFailedAtMs: toOptionalNumber(value.terminallyFailedAtMs),
  };
}

function emptyWorkState(args: {
  conversationId: string;
  destination: Destination;
  nowMs: number;
}): ConversationWorkState {
  return {
    schemaVersion: CONVERSATION_WORK_SCHEMA_VERSION,
    conversationId: args.conversationId,
    consecutiveFailureCount: 0,
    destination: args.destination,
    messages: [],
    needsRun: false,
    updatedAtMs: args.nowMs,
  };
}

function isLeaseActive(
  lease: ConversationLease | undefined,
  nowMs: number,
): boolean {
  return Boolean(lease && lease.leaseExpiresAtMs > nowMs);
}

function pendingMessages(state: ConversationWorkState): InboundMessageRecord[] {
  return state.messages
    .filter((message) => message.injectedAtMs === undefined)
    .sort(compareMessages);
}

function shouldKeepIndexed(state: ConversationWorkState): boolean {
  if (state.terminallyFailedAtMs !== undefined) {
    return false;
  }
  return (
    state.needsRun || Boolean(state.lease) || pendingMessages(state).length > 0
  );
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
  callback: () => Promise<T>,
): Promise<T> {
  const startedAtMs = now();
  let lock: Lock | null;
  while (true) {
    lock = await state.acquireLock(
      indexLockKey(),
      CONVERSATION_WORK_INDEX_LOCK_TTL_MS,
    );
    if (lock) {
      break;
    }
    if (now() - startedAtMs >= CONVERSATION_WORK_INDEX_LOCK_WAIT_MS) {
      throw new Error("Could not acquire conversation work index lock");
    }
    await sleep(CONVERSATION_WORK_INDEX_LOCK_RETRY_MS);
  }
  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

async function addToIndex(
  state: StateAdapter,
  conversationId: string,
): Promise<void> {
  await withIndexLock(state, async () => {
    const existing = uniqueStrings(
      (await state.get<unknown[]>(indexKey())) ?? [],
    );
    if (existing.includes(conversationId)) {
      return;
    }
    const indexed = [...existing, conversationId];
    const remove = new Set<string>();
    for (const id of indexed) {
      if (indexed.length - remove.size <= CONVERSATION_WORK_INDEX_MAX_LENGTH) {
        break;
      }
      const work = await readWorkState(state, id);
      if (!work || !shouldKeepIndexed(work)) {
        remove.add(id);
      }
    }
    await state.set(
      indexKey(),
      indexed.filter((id) => !remove.has(id)),
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });
}

async function removeFromIndex(
  state: StateAdapter,
  conversationId: string,
): Promise<void> {
  await withIndexLock(state, async () => {
    const existing = uniqueStrings(
      (await state.get<unknown[]>(indexKey())) ?? [],
    );
    const next = existing.filter((id) => id !== conversationId);
    if (next.length === existing.length) {
      return;
    }
    await state.set(indexKey(), next, JUNIOR_THREAD_STATE_TTL_MS);
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
      CONVERSATION_WORK_MUTATION_LOCK_TTL_MS,
    );
    if (lock) {
      return lock;
    }
    if (now() - startedAtMs >= CONVERSATION_WORK_MUTATION_WAIT_MS) {
      throw new Error(
        `Could not acquire conversation work mutation lock for ${conversationId}`,
      );
    }
    await sleep(CONVERSATION_WORK_MUTATION_RETRY_MS);
  }
}

async function withConversationMutation<T>(
  args: {
    conversationId: string;
    state?: StateAdapter;
  },
  callback: (state: StateAdapter) => Promise<T>,
): Promise<T> {
  const state = await getConnectedState(args.state);
  const lock = await acquireMutationLock(state, args.conversationId);
  try {
    return await callback(state);
  } finally {
    await state.releaseLock(lock);
  }
}

async function readWorkState(
  state: StateAdapter,
  conversationId: string,
): Promise<ConversationWorkState | undefined> {
  const raw = await state.get(stateKey(conversationId));
  if (raw == null) {
    return undefined;
  }
  const work = normalizeWorkState(conversationId, raw);
  if (!work) {
    throw new Error(`Conversation work state is invalid for ${conversationId}`);
  }
  return work;
}

async function writeWorkState(
  state: StateAdapter,
  work: ConversationWorkState,
): Promise<void> {
  await state.set(
    stateKey(work.conversationId),
    work,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
  if (shouldKeepIndexed(work)) {
    await addToIndex(state, work.conversationId);
  } else {
    await removeFromIndex(state, work.conversationId);
  }
}

function hasRunnableWork(state: ConversationWorkState): boolean {
  if (state.terminallyFailedAtMs !== undefined) {
    return false;
  }
  return state.needsRun || pendingMessages(state).length > 0;
}

function assertSameConversationDestination(args: {
  conversationId: string;
  current: Destination;
  next: Destination;
}): void {
  if (sameDestination(args.current, args.next)) {
    return;
  }
  throw new Error(
    `Conversation work destination changed for ${args.conversationId}`,
  );
}

/** Return a persisted conversation work record, if one exists. */
export async function getConversationWorkState(args: {
  conversationId: string;
  state?: StateAdapter;
}): Promise<ConversationWorkState | undefined> {
  const state = await getConnectedState(args.state);
  return await readWorkState(state, args.conversationId);
}

/** Count mailbox messages that have not yet reached the session log. */
export function countPendingConversationMessages(
  state: ConversationWorkState,
): number {
  return pendingMessages(state).length;
}

/** Return whether a conversation has pending or resumable execution work. */
export function hasRunnableConversationWork(
  state: ConversationWorkState,
): boolean {
  return hasRunnableWork(state);
}

/** Persist one inbound message idempotently in its conversation mailbox. */
export async function appendInboundMessage(args: {
  message: InboundMessageRecord;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<AppendInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(
    { conversationId: args.message.conversationId, state: args.state },
    async (state) => {
      const current =
        (await readWorkState(state, args.message.conversationId)) ??
        emptyWorkState({
          conversationId: args.message.conversationId,
          destination: args.message.destination,
          nowMs,
        });
      assertSameConversationDestination({
        conversationId: args.message.conversationId,
        current: current.destination,
        next: args.message.destination,
      });
      const existing = current.messages.find(
        (message) => message.inboundMessageId === args.message.inboundMessageId,
      );
      if (existing) {
        const next: ConversationWorkState = {
          ...current,
          needsRun: current.needsRun || existing.injectedAtMs === undefined,
          updatedAtMs: nowMs,
        };
        await writeWorkState(state, next);
        return { status: "duplicate" };
      }

      const next: ConversationWorkState = {
        ...current,
        consecutiveFailureCount: 0,
        lastFailureAtMs: undefined,
        messages: [...current.messages, args.message].sort(compareMessages),
        needsRun: true,
        terminallyFailedAtMs: undefined,
        updatedAtMs: nowMs,
      };
      await writeWorkState(state, next);
      return { status: "appended" };
    },
  );
}

/** Persist inbound work and send the queue nudge that wakes a worker. */
export async function appendAndEnqueueInboundMessage(args: {
  message: InboundMessageRecord;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const nowMs = args.nowMs ?? now();
  const appendResult = await appendInboundMessage({
    message: args.message,
    nowMs,
    state: args.state,
  });
  let idempotencyKey = args.message.inboundMessageId;
  if (appendResult.status === "duplicate") {
    const work = await getConversationWorkState({
      conversationId: args.message.conversationId,
      state: args.state,
    });
    if (!work || hasRecentEnqueueMarker(work, nowMs)) {
      return appendResult;
    }
    idempotencyKey = duplicateInboundNudgeIdempotencyKey(args.message, nowMs);
  }
  const queueResult = await args.queue.send(
    {
      conversationId: args.message.conversationId,
      destination: args.message.destination,
    },
    { idempotencyKey },
  );
  await markConversationWorkEnqueued({
    conversationId: args.message.conversationId,
    nowMs,
    state: args.state,
  });
  return {
    ...appendResult,
    queueMessageId: queueResult?.messageId,
  };
}

/** Mark a conversation runnable when there is no new mailbox message. */
export async function requestConversationWork(args: {
  conversationId: string;
  destination: Destination;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<RequestConversationWorkResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const existing = await readWorkState(state, args.conversationId);
    if (existing) {
      assertSameConversationDestination({
        conversationId: args.conversationId,
        current: existing.destination,
        next: args.destination,
      });
    }
    const current =
      existing ??
      emptyWorkState({
        conversationId: args.conversationId,
        destination: args.destination,
        nowMs,
      });
    await writeWorkState(state, {
      ...current,
      needsRun: true,
      updatedAtMs: nowMs,
    });
    return { status: existing === undefined ? "created" : "updated" };
  });
}

/** Record that a wake-up nudge was accepted for the conversation. */
export async function markConversationWorkEnqueued(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? now();
  await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current) {
      return;
    }
    await writeWorkState(state, {
      ...current,
      lastEnqueuedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  });
}

/** Try to acquire the durable execution lease for one conversation. */
export async function startConversationWork(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<ConversationLeaseStartResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current) {
      return { status: "no_work" };
    }
    if (isLeaseActive(current.lease, nowMs)) {
      return {
        status: "active",
        leaseExpiresAtMs: current.lease!.leaseExpiresAtMs,
      };
    }
    if (!hasRunnableWork(current)) {
      return { status: "no_work" };
    }

    const lease: ConversationLease = {
      leaseToken: randomUUID(),
      acquiredAtMs: nowMs,
      lastCheckInAtMs: nowMs,
      leaseExpiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
    };
    await writeWorkState(state, {
      ...current,
      lease,
      needsRun: false,
      updatedAtMs: nowMs,
    });
    return {
      status: "acquired",
      leaseToken: lease.leaseToken,
      leaseExpiresAtMs: lease.leaseExpiresAtMs,
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
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      return false;
    }
    await writeWorkState(state, {
      ...current,
      lease: {
        ...current.lease,
        lastCheckInAtMs: nowMs,
        leaseExpiresAtMs: nowMs + CONVERSATION_WORK_LEASE_TTL_MS,
      },
      updatedAtMs: nowMs,
    });
    return true;
  });
}

/** Drain pending mailbox entries after the caller has durably injected them. */
export async function drainConversationMailbox(args: {
  conversationId: string;
  inject: (messages: InboundMessageRecord[]) => Promise<void>;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<InboundMessageRecord[]> {
  const nowMs = args.nowMs ?? now();
  const pending = await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      throw new Error(
        `Conversation work lease is not held for ${args.conversationId}`,
      );
    }
    return pendingMessages(current);
  });
  if (pending.length === 0) {
    return [];
  }

  await args.inject(pending);

  await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      throw new Error(
        `Conversation work lease is not held for ${args.conversationId}`,
      );
    }
    const drainedIds = new Set(
      pending.map((message) => message.inboundMessageId),
    );
    const messages = current.messages.map((message) =>
      drainedIds.has(message.inboundMessageId)
        ? { ...message, injectedAtMs: nowMs }
        : message,
    );
    const hasPending = messages.some(
      (message) => message.injectedAtMs === undefined,
    );
    await writeWorkState(state, {
      ...current,
      consecutiveFailureCount: 0,
      lastFailureAtMs: undefined,
      messages,
      needsRun: hasPending,
      updatedAtMs: nowMs,
    });
  });
  return pending;
}

/** Mark selected leased mailbox entries after their session-log injection succeeds. */
export async function markConversationMessagesInjected(args: {
  conversationId: string;
  inboundMessageIds: string[];
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  const inboundMessageIds = new Set(args.inboundMessageIds);
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      return false;
    }
    if (inboundMessageIds.size === 0) {
      return true;
    }

    let changed = false;
    const messages = current.messages.map((message) => {
      if (
        !inboundMessageIds.has(message.inboundMessageId) ||
        message.injectedAtMs !== undefined
      ) {
        return message;
      }
      changed = true;
      return { ...message, injectedAtMs: nowMs };
    });
    if (!changed) {
      return true;
    }

    await writeWorkState(state, {
      ...current,
      consecutiveFailureCount: 0,
      lastFailureAtMs: undefined,
      messages,
      updatedAtMs: nowMs,
    });
    return true;
  });
}

/** Mark the leased conversation as needing another queue-delivered slice. */
export async function requestConversationContinuation(args: {
  conversationId: string;
  destination: Destination;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      return false;
    }
    assertSameConversationDestination({
      conversationId: args.conversationId,
      current: current.destination,
      next: args.destination,
    });
    await writeWorkState(state, {
      ...current,
      needsRun: true,
      updatedAtMs: nowMs,
    });
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
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      return false;
    }
    await writeWorkState(state, {
      ...current,
      lease: undefined,
      updatedAtMs: nowMs,
    });
    return true;
  });
}

/** Finish a leased conversation and report whether runnable work remains. */
export async function completeConversationWork(args: {
  conversationId: string;
  leaseToken: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<"completed" | "lost_lease" | "pending"> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current || current.lease?.leaseToken !== args.leaseToken) {
      return "lost_lease";
    }
    const hasPending = pendingMessages(current).length > 0;
    const hasRunnableWork = current.needsRun || hasPending;
    await writeWorkState(state, {
      ...current,
      consecutiveFailureCount: 0,
      lastFailureAtMs: undefined,
      lease: undefined,
      needsRun: hasRunnableWork,
      updatedAtMs: nowMs,
    });
    return hasRunnableWork ? "pending" : "completed";
  });
}

/** Clear an expired durable lease so a later worker can resume safely. */
export async function clearExpiredConversationLease(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<boolean> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current?.lease || current.lease.leaseExpiresAtMs > nowMs) {
      return false;
    }
    await writeWorkState(state, {
      ...current,
      lease: undefined,
      needsRun: true,
      updatedAtMs: nowMs,
    });
    return true;
  });
}

export interface RecordConversationWorkFailureResult {
  abandoned: boolean;
  consecutiveFailureCount: number;
  releasedLease: boolean;
}

/**
 * Increment the durable failure counter after a caught worker error so
 * deterministic poison work cannot churn the queue forever. When the counter
 * crosses {@link CONVERSATION_WORK_MAX_CONSECUTIVE_FAILURES}, the conversation
 * is marked terminally failed: the lease is cleared, pending mailbox messages
 * are dropped, and the conversation drops out of the recovery index so neither
 * the worker nor heartbeat will requeue it again. A later inbound message
 * resets the counter and gives the conversation a fresh attempt.
 */
export async function recordConversationWorkFailure(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<RecordConversationWorkFailureResult> {
  const nowMs = args.nowMs ?? now();
  return await withConversationMutation(args, async (state) => {
    const current = await readWorkState(state, args.conversationId);
    if (!current) {
      return {
        abandoned: false,
        consecutiveFailureCount: 0,
        releasedLease: false,
      };
    }
    const consecutiveFailureCount = current.consecutiveFailureCount + 1;
    const abandoned =
      consecutiveFailureCount >= CONVERSATION_WORK_MAX_CONSECUTIVE_FAILURES;
    if (!abandoned) {
      await writeWorkState(state, {
        ...current,
        consecutiveFailureCount,
        lastFailureAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      return {
        abandoned: false,
        consecutiveFailureCount,
        releasedLease: false,
      };
    }
    const releasedLease = Boolean(current.lease);
    const drainedMessages = current.messages.filter(
      (message) => message.injectedAtMs !== undefined,
    );
    await writeWorkState(state, {
      ...current,
      consecutiveFailureCount,
      lastFailureAtMs: nowMs,
      lease: undefined,
      messages: drainedMessages,
      needsRun: false,
      terminallyFailedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return {
      abandoned: true,
      consecutiveFailureCount,
      releasedLease,
    };
  });
}

/** Claim bounded recovery candidates and rotate them behind unscanned ids. */
export async function claimConversationWorkRecoveryIds(
  args: {
    limit?: number;
    state?: StateAdapter;
  } = {},
): Promise<string[]> {
  const state = await getConnectedState(args.state);
  return await withIndexLock(state, async () => {
    const ids = uniqueStrings((await state.get<unknown[]>(indexKey())) ?? []);
    const limit = Math.max(0, args.limit ?? ids.length);
    const selected = ids.slice(0, limit);
    if (selected.length > 0 && selected.length < ids.length) {
      await state.set(
        indexKey(),
        [...ids.slice(selected.length), ...selected],
        JUNIOR_THREAD_STATE_TTL_MS,
      );
    }
    return selected;
  });
}
