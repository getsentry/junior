import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import {
  destinationSchema,
  destinationVisibilitySchema,
  isSlackDestination,
  sourceSchema,
  type SlackDestination,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { credentialSubjectSchema } from "@/chat/credentials/context";
import { destinationKey } from "@/chat/destination";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import type {
  BoundDispatchOptions,
  DispatchCreateResult,
  DispatchProjection,
  DispatchRecord,
  DispatchStatus,
} from "./types";

const DISPATCH_PREFIX = "junior:agent_dispatch";
const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
const DISPATCH_INDEX_LOCK_TTL_MS = 10_000;
const DISPATCH_INDEX_MAX_LENGTH = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

const nonEmptyExactStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim() && value.toLowerCase() !== "unknown",
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
    attempt: z.number().int().nonnegative(),
    createdAtMs: z.number().finite(),
    credentialSubject: credentialSubjectSchema.optional(),
    destination: destinationSchema,
    destinationVisibility: destinationVisibilitySchema,
    errorMessage: z.string().optional(),
    id: nonEmptyExactStringSchema,
    idempotencyKey: z.string().min(1),
    input: z.string().min(1),
    lastCallbackAtMs: z.number().finite().optional(),
    leaseExpiresAtMs: z.number().finite().optional(),
    maxAttempts: z.number().int().positive(),
    metadata: z.record(z.string(), z.string()).optional(),
    plugin: nonEmptyExactStringSchema,
    resultMessageTs: z.string().optional(),
    source: sourceSchema,
    status: dispatchStatusSchema,
    updatedAtMs: z.number().finite(),
    version: z.number().int().positive(),
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
      subject.binding.type !== "scheduled-task" ||
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

/** Keep dispatch persistence keys consistent across callback and recovery paths. */
export function getDispatchStorageKey(id: string): string {
  return `${DISPATCH_PREFIX}:record:${id}`;
}

function incompleteDispatchIndexKey(): string {
  return `${DISPATCH_PREFIX}:incomplete`;
}

function incompleteDispatchIndexLockKey(): string {
  return `${DISPATCH_PREFIX}:incomplete:lock`;
}

function dispatchLockKey(id: string): string {
  return `${DISPATCH_PREFIX}:lock:${id}`;
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

/** Parse persisted dispatch records before recovery, callbacks, or projections use them. */
export function parseDispatchRecord(
  value: unknown,
): DispatchRecord | undefined {
  const parsed = dispatchRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as DispatchRecord) : undefined;
}

/** Map a dispatch destination to the lock key that serializes Slack delivery. */
export function getDispatchDestinationLockId(
  destination: SlackDestination,
): string {
  return destinationKey(destination);
}

/** Return the isolated persisted conversation key for one dispatch run. */
export function getDispatchConversationId(
  dispatch: Pick<DispatchRecord, "id">,
): string {
  return `agent-dispatch:${dispatch.id}`;
}

/** Give dispatch slices stable turn ids for resumability and trace correlation. */
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

/** Serialize mutations for a dispatch so callbacks and heartbeats stay idempotent. */
export async function withDispatchLock<T>(
  dispatchId: string,
  callback: (state: StateAdapter) => Promise<T>,
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
    return await callback(state);
  } finally {
    await state.releaseLock(lock);
  }
}

async function withIncompleteDispatchIndexLock<T>(
  state: StateAdapter,
  callback: () => Promise<T>,
): Promise<T> {
  const lock: Lock | null = await state.acquireLock(
    incompleteDispatchIndexLockKey(),
    DISPATCH_INDEX_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error("Could not acquire incomplete dispatch index lock");
  }

  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

async function syncIncompleteDispatchIndex(
  state: StateAdapter,
  record: DispatchRecord,
): Promise<void> {
  await withIncompleteDispatchIndexLock(state, async () => {
    const existing =
      (await state.get<string[]>(incompleteDispatchIndexKey())) ?? [];
    const ids = [
      ...new Set(existing.filter((id): id is string => typeof id === "string")),
    ];
    const next = isTerminalDispatchStatus(record.status)
      ? ids.filter((id) => id !== record.id)
      : ids.includes(record.id)
        ? ids
        : [...ids, record.id];

    if (
      next.length === ids.length &&
      next.every((id, index) => id === ids[index])
    ) {
      return;
    }

    await state.set(
      incompleteDispatchIndexKey(),
      next.slice(-DISPATCH_INDEX_MAX_LENGTH),
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });
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
  await syncIncompleteDispatchIndex(state, next);
}

/** Load dispatch state for callback, recovery, and plugin projection paths. */
export async function getDispatchRecord(
  id: string,
): Promise<DispatchRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return parseDispatchRecord(await state.get(getDispatchStorageKey(id)));
}

/** Create a plugin dispatch idempotently from the plugin's idempotency key. */
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
      attempt: 0,
      createdAtMs: args.nowMs,
      ...(args.options.credentialSubject
        ? { credentialSubject: args.options.credentialSubject }
        : {}),
      destination: args.options.destination,
      destinationVisibility: args.options.destinationVisibility,
      id,
      idempotencyKey: args.options.idempotencyKey,
      input: args.options.input,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      ...(metadata ? { metadata } : {}),
      plugin: args.plugin,
      status: "pending",
      source: args.options.source,
      updatedAtMs: args.nowMs,
      version: 1,
    };
    await putRecord(state, record);
    return { record, status: "created" };
  });
}

/** Advance dispatch versions so stale callbacks cannot overwrite newer state. */
export async function updateDispatchRecord(
  state: StateAdapter,
  record: DispatchRecord,
): Promise<DispatchRecord> {
  const next = {
    ...record,
    updatedAtMs: Date.now(),
    version: record.version + 1,
  };
  await putRecord(state, next);
  return next;
}

/** Feed heartbeat recovery from the durable incomplete-dispatch index. */
export async function listIncompleteDispatchIds(): Promise<string[]> {
  const state = getStateAdapter();
  await state.connect();
  const ids = (await state.get<string[]>(incompleteDispatchIndexKey())) ?? [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
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
