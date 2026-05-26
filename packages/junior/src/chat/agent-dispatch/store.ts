import { createHash } from "node:crypto";
import { THREAD_STATE_TTL_MS } from "chat";
import type { Lock, StateAdapter } from "chat";
import { getStateAdapter } from "@/chat/state/adapter";
import type {
  DispatchCreateResult,
  DispatchOptions,
  DispatchProjection,
  DispatchRecord,
  DispatchStatus,
} from "./types";

const DISPATCH_PREFIX = "junior:agent_dispatch";
const DISPATCH_LOCK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function getDispatchStorageKey(id: string): string {
  return `${DISPATCH_PREFIX}:record:${id}`;
}

function incompleteDispatchIndexKey(): string {
  return `${DISPATCH_PREFIX}:incomplete`;
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

export function getDispatchConversationId(
  destination: DispatchRecord["destination"],
): string {
  return `slack:${destination.teamId}:${destination.channelId}`;
}

export function getDispatchTurnId(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}

export function toDispatchProjection(
  record: DispatchRecord,
): DispatchProjection {
  return {
    id: record.id,
    status: record.status,
    ...(record.resultMessageTs
      ? { resultMessageTs: record.resultMessageTs }
      : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
}

export function isTerminalDispatchStatus(status: DispatchStatus): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

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

async function putRecord(
  state: StateAdapter,
  record: DispatchRecord,
): Promise<void> {
  await state.set(
    getDispatchStorageKey(record.id),
    record,
    THREAD_STATE_TTL_MS,
  );
  if (!isTerminalDispatchStatus(record.status)) {
    await state.appendToList(incompleteDispatchIndexKey(), record.id, {
      maxLength: 10_000,
      ttlMs: THREAD_STATE_TTL_MS,
    });
  }
}

export async function getDispatchRecord(
  id: string,
): Promise<DispatchRecord | undefined> {
  const state = getStateAdapter();
  await state.connect();
  return (
    (await state.get<DispatchRecord>(getDispatchStorageKey(id))) ?? undefined
  );
}

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

export async function listIncompleteDispatchIds(): Promise<string[]> {
  const state = getStateAdapter();
  await state.connect();
  const ids = (await state.getList<string>(incompleteDispatchIndexKey())) ?? [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

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
