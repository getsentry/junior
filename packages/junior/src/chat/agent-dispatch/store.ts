import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import {
  destinationSchema,
  destinationVisibilitySchema,
  isSlackDestination,
  replyAttributionSchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { credentialSubjectSchema } from "@/chat/credentials/context";
import { getConversationStore } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { recordTaskExecution } from "@/chat/tasks/execution-stats";
import type {
  BoundDispatchOptions,
  DispatchCreateResult,
  DispatchProjection,
  DispatchRecord,
  DispatchStatus,
} from "./types";

const DISPATCH_PREFIX = "junior:agent_dispatch";
const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
const DISPATCH_MAILBOX_APPEND_INDEX_LOCK_TTL_MS = 10_000;
const DISPATCH_MAILBOX_APPEND_INDEX_MAX_LENGTH = 10_000;

const nonEmptyExactStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim() && value.toLowerCase() !== "unknown",
  );
const pendingDispatchMailboxAppendIndexSchema = z.array(
  nonEmptyExactStringSchema,
);
const dispatchStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_resume",
  "completed",
  "failed",
  "blocked",
]);
const dispatchActorSchema = z
  .object({
    platform: z.literal("system"),
    name: nonEmptyExactStringSchema,
  })
  .strict();
const dispatchRecordSchema = z
  .object({
    actor: dispatchActorSchema,
    createdAtMs: z.number().finite(),
    credentialSubject: credentialSubjectSchema.optional(),
    creator: z
      .object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/) })
      .strict()
      .optional(),
    destination: destinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    errorMessage: z.string().optional(),
    id: nonEmptyExactStringSchema,
    idempotencyKey: z.string().min(1),
    input: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    plugin: nonEmptyExactStringSchema,
    replyAttribution: replyAttributionSchema.optional(),
    resultMessageTs: z.string().optional(),
    source: sourceSchema,
    status: dispatchStatusSchema,
    updatedAtMs: z.number().finite(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (!isSlackDestination(record.destination)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dispatch destination platform must be slack",
        path: ["destination"],
      });
      return;
    }
    const subject = record.credentialSubject;
    if (!subject) {
      return;
    }
    if (subject.allowedWhen === "private-direct-conversation") {
      if (!record.destination.channelId.startsWith("D")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Dispatch credentialSubject requires a private direct Slack destination",
          path: ["credentialSubject"],
        });
        return;
      }
      if (
        subject.binding.type !== "slack-direct-conversation" ||
        subject.binding.teamId !== record.destination.teamId ||
        subject.binding.channelId !== record.destination.channelId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dispatch credentialSubject binding must match destination",
          path: ["credentialSubject", "binding"],
        });
      }
      return;
    }
    if (
      subject.binding.type !== subject.allowedWhen ||
      subject.binding.plugin !== record.plugin ||
      subject.binding.taskId !== subject.taskId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dispatch credentialSubject binding must match task",
        path: ["credentialSubject", "binding"],
      });
    }
  });

// TODO(v0.116.0): Remove legacy dispatch execution fields after records written
// by the callback-owned lifecycle have expired.
const storedDispatchRecordSchema = dispatchRecordSchema.extend({
  attempt: z.number().int().nonnegative().optional(),
  lastCallbackAtMs: z.number().finite().optional(),
  leaseExpiresAtMs: z.number().finite().optional(),
  maxAttempts: z.number().int().positive().optional(),
  version: z.number().int().positive().optional(),
});

/** Return the durable key for one plugin-facing dispatch projection. */
export function getDispatchStorageKey(id: string): string {
  return `${DISPATCH_PREFIX}:record:${id}`;
}

function dispatchLockKey(id: string): string {
  return `${DISPATCH_PREFIX}:lock:${id}`;
}

function pendingDispatchMailboxAppendIndexKey(): string {
  // TODO(v0.116.0): Rename after the old callback-owned incomplete index has
  // aged out. Reusing the key preserves pending pre-cutover mailbox appends.
  return `${DISPATCH_PREFIX}:incomplete`;
}

function pendingDispatchMailboxAppendIndexLockKey(): string {
  return `${DISPATCH_PREFIX}:incomplete:lock`;
}

function normalizeMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }
  const entries = Object.entries(metadata).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildDispatchId(plugin: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(plugin)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32);
  return `dispatch_${digest}`;
}

/** Parse current and rollout-compatible dispatch projection records. */
export function parseDispatchRecord(
  value: unknown,
): DispatchRecord | undefined {
  const parsed = parseStoredDispatchRecord(value);
  return parsed?.record;
}

function parseStoredDispatchRecord(value: unknown):
  | {
      legacyLeaseExpiresAtMs?: number;
      record: DispatchRecord;
    }
  | undefined {
  const parsed = storedDispatchRecordSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const {
    attempt: _attempt,
    lastCallbackAtMs: _lastCallbackAtMs,
    leaseExpiresAtMs: _leaseExpiresAtMs,
    maxAttempts: _maxAttempts,
    version: _version,
    ...record
  } = parsed.data;
  return {
    ...(typeof parsed.data.leaseExpiresAtMs === "number"
      ? { legacyLeaseExpiresAtMs: parsed.data.leaseExpiresAtMs }
      : {}),
    record: record as DispatchRecord,
  };
}

/** Return the isolated durable conversation id for one dispatch. */
export function getDispatchConversationId(
  dispatch: Pick<DispatchRecord, "id">,
): string {
  return `agent-dispatch:${dispatch.id}`;
}

/** Return the stable synthetic input message id for one dispatch turn. */
export function getDispatchInputMessageId(dispatchId: string): string {
  return `agent-dispatch:${dispatchId}`;
}

/**
 * Return the synthetic input id written by the pre-conversation-work runner.
 *
 * TODO(v0.116.0): Remove after v0.114 dispatch sessions can no longer resume.
 */
export function getLegacyDispatchInputMessageId(dispatchId: string): string {
  return `dispatch:${dispatchId}:user`;
}

/** Return every persisted input id accepted while resuming one dispatch. */
export function getDispatchInputMessageIds(
  dispatchId: string,
): readonly string[] {
  return [
    getDispatchInputMessageId(dispatchId),
    getLegacyDispatchInputMessageId(dispatchId),
  ];
}

/** Return the stable turn id used by every run of one dispatch. */
export function getDispatchTurnId(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}

function toDispatchProjection(record: DispatchRecord): DispatchProjection {
  return {
    id: record.id,
    status: record.status,
    ...(record.resultMessageTs
      ? { resultMessageTs: record.resultMessageTs }
      : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
}

/** Gate recovery to dispatches that can still make progress. */
export function isTerminalDispatchStatus(status: DispatchStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

/** Serialize dispatch projection mutations. */
async function withDispatchLock<T>(
  dispatchId: string,
  task: (state: StateAdapter) => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  await state.connect();
  const lock: Lock | null = await state.acquireLock(
    dispatchLockKey(dispatchId),
    DISPATCH_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(`Could not acquire dispatch lock for ${dispatchId}`);
  }

  try {
    return await task(state);
  } finally {
    await state.releaseLock(lock);
  }
}

async function putRecord(
  state: StateAdapter,
  record: DispatchRecord,
): Promise<void> {
  const parsed = dispatchRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(
      `Dispatch record is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const next = parsed.data as DispatchRecord;
  await state.set(
    getDispatchStorageKey(next.id),
    next,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
}

async function updatePendingDispatchMailboxAppendIndex(
  state: StateAdapter,
  update: (ids: string[]) => string[],
): Promise<void> {
  const lock = await state.acquireLock(
    pendingDispatchMailboxAppendIndexLockKey(),
    DISPATCH_MAILBOX_APPEND_INDEX_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error("Could not acquire dispatch mailbox append index lock");
  }
  try {
    const stored = await state.get(pendingDispatchMailboxAppendIndexKey());
    const ids =
      stored === undefined || stored === null
        ? []
        : pendingDispatchMailboxAppendIndexSchema.parse(stored);
    const next = [...new Set(update([...new Set(ids)]))].slice(
      -DISPATCH_MAILBOX_APPEND_INDEX_MAX_LENGTH,
    );
    if (
      next.length === ids.length &&
      next.every((id, index) => id === ids[index])
    ) {
      return;
    }
    await state.set(
      pendingDispatchMailboxAppendIndexKey(),
      next,
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  } finally {
    await state.releaseLock(lock);
  }
}

/** Load dispatch state for conversation work and plugin projections. */
export async function getDispatchRecord(
  id: string,
): Promise<DispatchRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseDispatchRecord(await state.get(getDispatchStorageKey(id)));
}

/** Create a dispatch idempotently within its owner namespace. */
export async function createOrGetDispatch(args: {
  nowMs: number;
  options: BoundDispatchOptions;
  plugin: string;
}): Promise<DispatchCreateResult> {
  const id = buildDispatchId(args.plugin, args.options.idempotencyKey);
  return await withDispatchLock(id, async (state) => {
    const existing = parseDispatchRecord(
      await state.get(getDispatchStorageKey(id)),
    );
    if (existing) {
      return { record: existing, status: "already_exists" };
    }

    const metadata = normalizeMetadata(args.options.metadata);
    const record: DispatchRecord = {
      actor: { platform: "system", name: args.plugin },
      createdAtMs: args.nowMs,
      ...(args.options.credentialSubject
        ? { credentialSubject: args.options.credentialSubject }
        : {}),
      ...(args.options.creator ? { creator: args.options.creator } : {}),
      destination: args.options.destination,
      destinationVisibility: args.options.destinationVisibility,
      id,
      idempotencyKey: args.options.idempotencyKey,
      input: args.options.input,
      ...(metadata ? { metadata } : {}),
      plugin: args.plugin,
      ...(args.options.replyAttribution
        ? { replyAttribution: args.options.replyAttribution }
        : {}),
      status: "pending",
      source: args.options.source,
      updatedAtMs: args.nowMs,
    };
    // Index first: a crash can leave a harmless dangling id, while writing the
    // record first could lose the only durable reminder to enqueue it.
    await updatePendingDispatchMailboxAppendIndex(state, (ids) =>
      ids.includes(id) ? ids : [...ids, id],
    );
    await putRecord(state, record);
    return { record, status: "created" };
  });
}

async function transitionDispatch(
  id: string,
  transition: (record: DispatchRecord) => DispatchRecord,
): Promise<DispatchRecord | undefined> {
  return await withDispatchLock(id, async (state) => {
    const current = parseDispatchRecord(
      await state.get(getDispatchStorageKey(id)),
    );
    if (!current) {
      return undefined;
    }
    const transitioned = transition(current);
    if (transitioned === current) {
      return current;
    }
    const next = {
      ...transitioned,
      updatedAtMs: Date.now(),
    };
    await putRecord(state, next);
    return next;
  });
}

/** Mark a dispatch projection as actively running. */
export async function markDispatchRunning(
  id: string,
): Promise<DispatchRecord | undefined> {
  return await transitionDispatch(id, (record) =>
    isTerminalDispatchStatus(record.status)
      ? record
      : { ...record, status: "running", errorMessage: undefined },
  );
}

/** Project a durable awaiting-resume turn state to the plugin API. */
export async function markDispatchAwaitingResume(
  id: string,
): Promise<DispatchRecord | undefined> {
  return await transitionDispatch(id, (record) =>
    isTerminalDispatchStatus(record.status)
      ? record
      : {
          ...record,
          status: "awaiting_resume",
        },
  );
}

async function recordEventTaskExecution(
  previous: DispatchRecord | undefined,
  next: DispatchRecord | undefined,
  status: "blocked" | "completed" | "failed",
): Promise<void> {
  if (!next || next.status !== status || previous?.status === status) return;
  if (next.plugin !== "junior") return;
  const eventTaskId = next.metadata?.eventTaskId;
  if (!eventTaskId) return;
  // Only link a conversation when enqueue already created the durable row.
  // Early failed/blocked dispatches can terminate before that write, and the
  // execution table still FKs conversation_id when present.
  const conversationId = getDispatchConversationId(next);
  const conversation = await getConversationStore().get({ conversationId });
  await recordTaskExecution("event", eventTaskId, {
    ...(conversation ? { conversationId } : {}),
    executionId: next.id,
    nowMs: next.updatedAtMs,
    status,
  });
}

/** Project a blocked turn to the plugin API. */
export async function markDispatchBlocked(
  id: string,
  errorMessage: string,
  resultMessageTs?: string,
): Promise<DispatchRecord | undefined> {
  const previous = await getDispatchRecord(id);
  const next = await transitionDispatch(id, (record) =>
    isTerminalDispatchStatus(record.status)
      ? record
      : {
          ...record,
          errorMessage,
          ...(resultMessageTs ? { resultMessageTs } : {}),
          status: "blocked",
        },
  );
  await recordEventTaskExecution(previous, next, "blocked");
  return next;
}

/** Project a completed turn and its accepted Slack message to the plugin API. */
export async function markDispatchCompleted(
  id: string,
  resultMessageTs?: string,
): Promise<DispatchRecord | undefined> {
  const previous = await getDispatchRecord(id);
  const next = await transitionDispatch(id, (record) =>
    isTerminalDispatchStatus(record.status)
      ? record
      : {
          ...record,
          errorMessage: undefined,
          ...(resultMessageTs ? { resultMessageTs } : {}),
          status: "completed",
        },
  );
  await recordEventTaskExecution(previous, next, "completed");
  return next;
}

/** Project a terminal conversation turn failure to the plugin API. */
export async function markDispatchFailed(
  id: string,
  errorMessage: string,
  resultMessageTs?: string,
): Promise<DispatchRecord | undefined> {
  const previous = await getDispatchRecord(id);
  const next = await transitionDispatch(id, (record) =>
    isTerminalDispatchStatus(record.status)
      ? record
      : {
          ...record,
          errorMessage,
          ...(resultMessageTs ? { resultMessageTs } : {}),
          status: "failed",
        },
  );
  await recordEventTaskExecution(previous, next, "failed");
  return next;
}

/** Remove a dispatch after its durable mailbox append has succeeded. */
export async function confirmDispatchMailboxAppend(id: string): Promise<void> {
  const state = getStateAdapter();
  await state.connect();
  await updatePendingDispatchMailboxAppendIndex(state, (ids) =>
    ids.filter((candidate) => candidate !== id),
  );
}

/** List dispatches whose durable mailbox append may not have completed. */
export async function listPendingDispatchMailboxAppends(): Promise<string[]> {
  const state = getStateAdapter();
  await state.connect();
  const stored = await state.get(pendingDispatchMailboxAppendIndexKey());
  return stored === undefined || stored === null
    ? []
    : [...new Set(pendingDispatchMailboxAppendIndexSchema.parse(stored))];
}

/**
 * Atomically move a rollout-era record behind conversation-owned execution.
 *
 * Rewriting the canonical record under the dispatch lock removes the callback
 * version/lease claim before mailbox work can become visible.
 */
export async function claimDispatchMailboxAppend(
  id: string,
  nowMs: number,
): Promise<DispatchRecord | undefined> {
  return await withDispatchLock(id, async (state) => {
    const stored = parseStoredDispatchRecord(
      await state.get(getDispatchStorageKey(id)),
    );
    if (
      !stored ||
      (stored.legacyLeaseExpiresAtMs && stored.legacyLeaseExpiresAtMs > nowMs)
    ) {
      return undefined;
    }
    await putRecord(state, stored.record);
    return stored.record;
  });
}

/** Return a plugin-scoped dispatch projection without exposing raw runtime state. */
export async function getPluginDispatchProjection(args: {
  id: string;
  plugin: string;
}): Promise<DispatchProjection | undefined> {
  const record = await getDispatchRecord(args.id);
  if (!record || record.plugin !== args.plugin) {
    return undefined;
  }
  return toDispatchProjection(record);
}
