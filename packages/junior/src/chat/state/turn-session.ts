/**
 * Turn session records.
 *
 * These records track one user request across auth pauses, timeout slices, and
 * completion. Full Pi messages live in the session log; this record stores
 * resumability metadata and committed message counts so resumes can materialize
 * the exact continuable boundary without duplicating the log.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import { isRecord } from "@/chat/coerce";
import type { PiMessage } from "@/chat/pi/messages";
import { commitMessages, loadMessages, loadProjection } from "./session-log";
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";

const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_TTL_MS = THREAD_STATE_TTL_MS;

export type AgentTurnSessionStatus =
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "abandoned";

export type AgentTurnResumeReason = "timeout" | "auth";

export interface AgentTurnSessionRecord {
  version: number;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  errorMessage?: string;
  piMessages: PiMessage[];
  resumeReason?: AgentTurnResumeReason;
  resumedFromSliceId?: number;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  updatedAtMs: number;
}

interface StoredAgentTurnSessionRecord extends Omit<
  AgentTurnSessionRecord,
  "piMessages"
> {
  committedMessageCount: number;
  logSessionId?: string;
}

function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

function toFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function parseAgentTurnUsage(value: unknown): AgentTurnUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage: AgentTurnUsage = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "totalTokens",
  ] as const) {
    const count = toFiniteNonNegativeNumber(value[field]);
    if (count !== undefined) {
      usage[field] = count;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseStoredRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseAgentTurnSessionRecord(
  value: unknown,
): StoredAgentTurnSessionRecord | undefined {
  const parsed = parseStoredRecord(value);
  if (!parsed) {
    return undefined;
  }

  const status = parsed.state;
  if (
    status !== "running" &&
    status !== "awaiting_resume" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "abandoned"
  ) {
    return undefined;
  }

  const conversationId = parsed.conversationId;
  const sessionId = parsed.sessionId;
  const sliceId = parsed.sliceId;
  const version = toFiniteNonNegativeNumber(parsed.version);
  const updatedAtMs = parsed.updatedAtMs;
  const committedMessageCount = toFiniteNonNegativeNumber(
    parsed.committedMessageCount,
  );
  const cumulativeDurationMs = toFiniteNonNegativeNumber(
    parsed.cumulativeDurationMs,
  );
  const cumulativeUsage = parseAgentTurnUsage(parsed.cumulativeUsage);
  const logSessionId =
    typeof parsed.logSessionId === "string" ? parsed.logSessionId : undefined;
  if (
    typeof conversationId !== "string" ||
    typeof sessionId !== "string" ||
    typeof sliceId !== "number" ||
    version === undefined ||
    committedMessageCount === undefined ||
    typeof updatedAtMs !== "number"
  ) {
    return undefined;
  }

  return {
    version,
    conversationId,
    sessionId,
    sliceId,
    state: status,
    updatedAtMs,
    committedMessageCount,
    ...(logSessionId ? { logSessionId } : {}),
    ...(cumulativeDurationMs !== undefined ? { cumulativeDurationMs } : {}),
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
    ...(parsed.resumeReason === "timeout" || parsed.resumeReason === "auth"
      ? { resumeReason: parsed.resumeReason }
      : {}),
    ...(typeof parsed.errorMessage === "string"
      ? { errorMessage: parsed.errorMessage }
      : {}),
    ...(typeof parsed.resumedFromSliceId === "number"
      ? { resumedFromSliceId: parsed.resumedFromSliceId }
      : {}),
  };
}

/**
 * Rehydrate the continuable Pi boundary from the session log, tolerating a
 * compacted projection when the exact historical prefix is no longer visible.
 */
function materializePiMessages(
  committedMessageCount: number,
  sessionMessages: PiMessage[] | undefined,
  sessionProjection: PiMessage[],
): PiMessage[] | undefined {
  if (committedMessageCount === 0) {
    return sessionProjection;
  }
  if (sessionProjection.length >= committedMessageCount) {
    return sessionProjection;
  }
  if (sessionMessages) {
    return sessionMessages;
  }
  return undefined;
}

function materializeAgentTurnSessionRecord(
  stored: StoredAgentTurnSessionRecord,
  piMessages: PiMessage[],
): AgentTurnSessionRecord {
  return {
    version: stored.version,
    conversationId: stored.conversationId,
    sessionId: stored.sessionId,
    sliceId: stored.sliceId,
    state: stored.state,
    updatedAtMs: stored.updatedAtMs,
    piMessages,
    ...(stored.cumulativeDurationMs !== undefined
      ? { cumulativeDurationMs: stored.cumulativeDurationMs }
      : {}),
    ...(stored.cumulativeUsage
      ? { cumulativeUsage: stored.cumulativeUsage }
      : {}),
    ...(stored.resumeReason ? { resumeReason: stored.resumeReason } : {}),
    ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {}),
    ...(stored.resumedFromSliceId !== undefined
      ? { resumedFromSliceId: stored.resumedFromSliceId }
      : {}),
  };
}

/** Read a materialized turn session record for resume and history loading. */
export async function getAgentTurnSessionRecord(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionRecord | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const value = await stateAdapter.get(
    agentTurnSessionKey(conversationId, sessionId),
  );
  const parsed = parseAgentTurnSessionRecord(value);
  if (!parsed) {
    return undefined;
  }

  const sessionMessages = await loadMessages({
    conversationId,
    messageCount: parsed.committedMessageCount,
    ...(parsed.logSessionId ? { sessionId: parsed.logSessionId } : {}),
  });
  const sessionProjection = await loadProjection({
    conversationId,
    ...(parsed.logSessionId ? { sessionId: parsed.logSessionId } : {}),
  });
  const piMessages = materializePiMessages(
    parsed.committedMessageCount,
    sessionMessages,
    sessionProjection,
  );
  if (!piMessages) {
    return undefined;
  }

  return materializeAgentTurnSessionRecord(parsed, piMessages);
}

/** Build the storage record that advances optimistic resume versioning. */
function buildStoredRecord(args: {
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  committedMessageCount: number;
  logSessionId?: string;
  previousVersion?: number;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
}): StoredAgentTurnSessionRecord {
  return {
    version: (args.previousVersion ?? 0) + 1,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    updatedAtMs: Date.now(),
    committedMessageCount: args.committedMessageCount,
    ...(args.logSessionId ? { logSessionId: args.logSessionId } : {}),
    ...(typeof args.cumulativeDurationMs === "number" &&
    Number.isFinite(args.cumulativeDurationMs)
      ? {
          cumulativeDurationMs: Math.max(
            0,
            Math.floor(args.cumulativeDurationMs),
          ),
        }
      : {}),
    ...(args.cumulativeUsage ? { cumulativeUsage: args.cumulativeUsage } : {}),
    ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(typeof args.resumedFromSliceId === "number"
      ? { resumedFromSliceId: args.resumedFromSliceId }
      : {}),
  };
}

async function setStoredRecord(args: {
  piMessages: PiMessage[];
  record: StoredAgentTurnSessionRecord;
  ttlMs: number;
}): Promise<AgentTurnSessionRecord> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  await stateAdapter.set(
    agentTurnSessionKey(args.record.conversationId, args.record.sessionId),
    args.record,
    args.ttlMs,
  );
  return materializeAgentTurnSessionRecord(args.record, [...args.piMessages]);
}

/**
 * Transition an unfinished session record only if the caller still holds the
 * version it loaded, preventing stale resume callbacks from winning.
 */
async function updateAgentTurnSessionState(args: {
  existing: AgentTurnSessionRecord;
  errorMessage?: string;
  state: "abandoned" | "failed";
}): Promise<AgentTurnSessionRecord | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const existingValue = await stateAdapter.get(
    agentTurnSessionKey(args.existing.conversationId, args.existing.sessionId),
  );
  const parsed = parseAgentTurnSessionRecord(existingValue);
  if (!parsed || parsed.version !== args.existing.version) {
    return undefined;
  }

  return await setStoredRecord({
    piMessages: args.existing.piMessages,
    ttlMs: AGENT_TURN_SESSION_TTL_MS,
    record: buildStoredRecord({
      conversationId: args.existing.conversationId,
      sessionId: args.existing.sessionId,
      sliceId: args.existing.sliceId,
      state: args.state,
      committedMessageCount: parsed.committedMessageCount,
      previousVersion: parsed.version,
      ...(parsed.logSessionId ? { logSessionId: parsed.logSessionId } : {}),
      ...(args.existing.cumulativeDurationMs !== undefined
        ? { cumulativeDurationMs: args.existing.cumulativeDurationMs }
        : {}),
      ...(args.existing.cumulativeUsage
        ? { cumulativeUsage: args.existing.cumulativeUsage }
        : {}),
      ...(args.existing.resumeReason
        ? { resumeReason: args.existing.resumeReason }
        : {}),
      ...(args.existing.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.existing.resumedFromSliceId }
        : {}),
      ...((args.errorMessage ?? args.existing.errorMessage)
        ? { errorMessage: args.errorMessage ?? args.existing.errorMessage }
        : {}),
    }),
  });
}

/** Commit stable Pi session state and advance the turn session record. */
export async function upsertAgentTurnSessionRecord(args: {
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  piMessages: PiMessage[];
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  ttlMs?: number;
}): Promise<AgentTurnSessionRecord> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const existingValue = await stateAdapter.get(
    agentTurnSessionKey(args.conversationId, args.sessionId),
  );
  const existingRecord = parseAgentTurnSessionRecord(existingValue);
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  const commit = await commitMessages({
    conversationId: args.conversationId,
    messages: args.piMessages,
    ttlMs,
  });

  return await setStoredRecord({
    piMessages: args.piMessages,
    ttlMs,
    record: buildStoredRecord({
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: args.state,
      committedMessageCount: args.piMessages.length,
      logSessionId: commit.sessionId,
      previousVersion: existingRecord?.version,
      ...(args.cumulativeDurationMs !== undefined
        ? { cumulativeDurationMs: args.cumulativeDurationMs }
        : {}),
      ...(args.cumulativeUsage
        ? { cumulativeUsage: args.cumulativeUsage }
        : {}),
      ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.resumedFromSliceId }
        : {}),
    }),
  });
}

/** Mark an unfinished turn session record as abandoned when a newer turn wins. */
export async function abandonAgentTurnSessionRecord(args: {
  conversationId: string;
  sessionId: string;
  errorMessage?: string;
}): Promise<AgentTurnSessionRecord | undefined> {
  const existing = await getAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  if (
    !existing ||
    existing.state === "completed" ||
    existing.state === "failed" ||
    existing.state === "abandoned"
  ) {
    return undefined;
  }

  return await updateAgentTurnSessionState({
    existing,
    state: "abandoned",
    errorMessage: args.errorMessage ?? existing.errorMessage,
  });
}

/** Mark an unfinished turn session record as failed so it cannot resume. */
export async function failAgentTurnSessionRecord(args: {
  conversationId: string;
  expectedVersion: number;
  sessionId: string;
  errorMessage?: string;
}): Promise<AgentTurnSessionRecord | undefined> {
  const existing = await getAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  if (
    !existing ||
    existing.state === "completed" ||
    existing.state === "failed" ||
    existing.state === "abandoned" ||
    existing.version !== args.expectedVersion
  ) {
    return undefined;
  }

  return await updateAgentTurnSessionState({
    existing,
    state: "failed",
    errorMessage: args.errorMessage ?? existing.errorMessage,
  });
}
