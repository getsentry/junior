import { createHash } from "node:crypto";
import type { Lock, StateAdapter } from "chat";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";
import type {
  DispatchCreateResult,
  DispatchOptions,
  DispatchProjection,
  DispatchRecord,
  DispatchStatus,
} from "./types";

const DISPATCH_PREFIX = "junior:agent_dispatch";
const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
const DISPATCH_INDEX_LOCK_TTL_MS = 10_000;
const DISPATCH_INDEX_MAX_LENGTH = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

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

/** Map a dispatch destination to the conversation lock and memory key it owns. */
export function getDispatchConversationId(
  destination: DispatchRecord["destination"],
): string {
  return `slack:${destination.teamId}:${destination.channelId}`;
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
  await state.set(
    getDispatchStorageKey(record.id),
    record,
    JUNIOR_THREAD_STATE_TTL_MS,
  );
  await syncIncompleteDispatchIndex(state, record);
}

/** Load dispatch state for callback, recovery, and plugin projection paths. */
export async function getDispatchRecord(
  id: string,
): Promise<DispatchRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return (
    (await state.get<DispatchRecord>(getDispatchStorageKey(id))) ?? undefined
  );
}

/** Create a plugin dispatch idempotently from the plugin's idempotency key. */
export async function createOrGetDispatch(args: {
  nowMs: number;
  options: DispatchOptions;
  plugin: string;
}): Promise<DispatchCreateResult> {
  const id = buildDispatchId(args.plugin, args.options.idempotencyKey);
  return await withDispatchLock(id, async (state) => {
    const existing =
      (await state.get<DispatchRecord>(getDispatchStorageKey(id))) ?? undefined;
    if (existing) {
      return { record: existing, status: "already_exists" };
    }

    const metadata = normalizeMetadata(args.options.metadata);
    const record: DispatchRecord = {
      actor: { type: "system", id: args.plugin },
      attempt: 0,
      createdAtMs: args.nowMs,
      ...(args.options.credentialSubject
        ? { credentialSubject: args.options.credentialSubject }
        : {}),
      destination: args.options.destination,
      id,
      idempotencyKey: args.options.idempotencyKey,
      input: args.options.input,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      ...(metadata ? { metadata } : {}),
      plugin: args.plugin,
      status: "pending",
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
