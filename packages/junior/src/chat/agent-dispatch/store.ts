import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import {
  destinationSchema,
  destinationVisibilitySchema,
  isSlackDestination,
  replyAttributionSchema,
  sourceSchema,
  taskOutcomeSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { credentialSubjectSchema } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { blockEventAutomation } from "@/chat/event-automations/store";
import { notifyAutomationBlocked } from "@/chat/automations/blocked-notice";
import type {
  BoundDispatchOptions,
  DispatchChange,
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
const dispatchActorSchema = z
  .object({
    platform: z.literal("system"),
    name: nonEmptyExactStringSchema,
  })
  .strict();
const dispatchFieldsSchema = z.object({
  actor: dispatchActorSchema,
  createdAtMs: z.number().finite(),
  credentialSubject: credentialSubjectSchema.optional(),
  destination: destinationSchema,
  destinationVisibility: destinationVisibilitySchema,
  id: nonEmptyExactStringSchema,
  idempotencyKey: z.string().min(1),
  input: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  plugin: nonEmptyExactStringSchema,
  replyAttribution: replyAttributionSchema.optional(),
  source: sourceSchema,
  outcomes: z.array(taskOutcomeSchema).max(5).optional(),
  updatedAtMs: z.number().finite(),
});
// Each state allows only its own fields. Records stored before this union
// already had this shape: only a finished write set `resultMessageTs`, and
// only a failed or blocked write set `errorMessage`.
const dispatchRecordSchema = z
  .discriminatedUnion("status", [
    dispatchFieldsSchema
      .extend({ status: z.enum(["pending", "running", "awaiting_resume"]) })
      .strict(),
    dispatchFieldsSchema
      .extend({
        status: z.literal("completed"),
        resultMessageTs: z.string().optional(),
      })
      .strict(),
    dispatchFieldsSchema
      .extend({
        status: z.enum(["blocked", "failed"]),
        errorMessage: z.string(),
        resultMessageTs: z.string().optional(),
      })
      .strict(),
  ])
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
    if (subject.allowedWhen === "timer-watch") {
      // Timer subjects belong to one Watch, never to a dispatch.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dispatch credentialSubject cannot use a timer Watch binding",
        path: ["credentialSubject", "allowedWhen"],
      });
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

/** Return the durable key for one plugin-facing dispatch projection. */
export function getDispatchStorageKey(id: string): string {
  return `${DISPATCH_PREFIX}:record:${id}`;
}

function dispatchLockKey(id: string): string {
  return `${DISPATCH_PREFIX}:lock:${id}`;
}

function pendingDispatchMailboxAppendIndexKey(): string {
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

const DISPATCH_ID_PREFIX = "agent-dispatch:";

/** Return the stable dispatch id for one plugin idempotency key. */
export function buildDispatchId(
  plugin: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(plugin)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32);
  return `dispatch_${digest}`;
}

/** Parse one durable dispatch projection record. */
export function parseDispatchRecord(
  value: unknown,
): DispatchRecord | undefined {
  const parsed = dispatchRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as DispatchRecord) : undefined;
}

/** Return the isolated durable conversation id for one dispatch. */
export function getDispatchConversationId(
  dispatch: Pick<DispatchRecord, "id">,
): string {
  return `${DISPATCH_ID_PREFIX}${dispatch.id}`;
}

/** Return the stable synthetic input message id for one dispatch turn. */
export function getDispatchInputMessageId(dispatchId: string): string {
  return `${DISPATCH_ID_PREFIX}${dispatchId}`;
}

/**
 * Return the dispatch id of a dispatch Conversation, such as an Automation
 * run. Other Conversations have no dispatch.
 */
export function getDispatchIdForConversation(
  conversationId: string,
): string | undefined {
  if (!conversationId.startsWith(DISPATCH_ID_PREFIX)) return undefined;
  return conversationId.slice(DISPATCH_ID_PREFIX.length) || undefined;
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
      : undefined),
    ...(record.errorMessage
      ? { errorMessage: record.errorMessage }
      : undefined),
  };
}

/** Gate recovery to dispatches that can still make progress. */
export function isTerminalDispatchStatus(
  status: DispatchStatus,
): status is "blocked" | "completed" | "failed" {
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
    const next = [...new Set(update([...new Set(ids)]))];
    // A dropped id would lose the only reminder to enqueue its dispatch, so a
    // full index rejects new dispatches instead.
    if (
      next.length > ids.length &&
      next.length > DISPATCH_MAILBOX_APPEND_INDEX_MAX_LENGTH
    ) {
      throw new Error(
        `Dispatch mailbox append index is full (${DISPATCH_MAILBOX_APPEND_INDEX_MAX_LENGTH} pending)`,
      );
    }
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
        : undefined),
      destination: args.options.destination,
      destinationVisibility: args.options.destinationVisibility,
      id,
      idempotencyKey: args.options.idempotencyKey,
      input: args.options.input,
      ...(metadata ? { metadata } : undefined),
      plugin: args.plugin,
      ...(args.options.replyAttribution
        ? { replyAttribution: args.options.replyAttribution }
        : undefined),
      ...(args.options.outcomes
        ? { outcomes: args.options.outcomes }
        : undefined),
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

function eventAutomationIdOf(record: DispatchRecord): string | undefined {
  return record.plugin === "junior"
    ? record.metadata?.eventAutomationId
    : undefined;
}

/**
 * Move one dispatch to its next state. This is the only writer of a stored
 * dispatch status. A finished dispatch keeps its state, so a late writer
 * cannot move it.
 *
 * The same step writes the copies of the outcome. An Event automation is
 * blocked before the stored state, so a retry after a failed write still
 * blocks it, and its creator is told once. The Automation run row is written
 * from the stored state on each call, so a retry rebuilds a row that a
 * stopped worker did not write. The heartbeat blocks a Scheduled automation
 * and tells its creator.
 */
export async function transitionDispatch(
  id: string,
  change: DispatchChange,
): Promise<DispatchRecord | undefined> {
  const result = await withDispatchLock(id, async (state) => {
    const current = parseDispatchRecord(
      await state.get(getDispatchStorageKey(id)),
    );
    if (!current || isTerminalDispatchStatus(current.status)) {
      return { record: current };
    }
    const eventAutomationId = eventAutomationIdOf(current);
    const blockedReason =
      change.status === "blocked" &&
      eventAutomationId &&
      (await blockEventAutomation(
        getDb(),
        eventAutomationId,
        change.errorMessage,
      ))
        ? change.errorMessage
        : undefined;
    // An unfinished record has no outcome fields, so the change sets all of
    // them. `putRecord` checks the result against the state union.
    const next = {
      ...current,
      ...change,
      updatedAtMs: Date.now(),
    } as DispatchRecord;
    await putRecord(state, next);
    return { blockedReason, record: next };
  });
  const record = result.record;
  if (!record) {
    return undefined;
  }
  const eventAutomationId = eventAutomationIdOf(record);
  if (eventAutomationId && result.blockedReason !== undefined) {
    await notifyAutomationBlocked({
      automationId: eventAutomationId,
      dispatchId: id,
      kind: "event",
      reason: result.blockedReason,
    });
  }
  if (eventAutomationId && isTerminalDispatchStatus(record.status)) {
    await recordAutomationExecution(eventAutomationId, {
      conversationId: getDispatchConversationId(record),
      errorMessage: record.errorMessage,
      executionId: record.id,
      nowMs: record.updatedAtMs,
      status: record.status,
    });
  }
  return record;
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

/** Load the dispatch under lock before its mailbox append becomes visible. */
export async function claimDispatchMailboxAppend(
  id: string,
): Promise<DispatchRecord | undefined> {
  return await withDispatchLock(id, async (state) => {
    return parseDispatchRecord(await state.get(getDispatchStorageKey(id)));
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
