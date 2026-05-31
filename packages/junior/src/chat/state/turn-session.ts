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

function parseAgentTurnSessionRecord(value: unknown):
  | {
      legacyPiMessages: PiMessage[];
      record: StoredAgentTurnSessionRecord;
    }
  | undefined {
  const parsed = parseStoredRecord(value);
  if (!parsed) {
    return undefined;
  }

  const status = parsed.state === "superseded" ? "abandoned" : parsed.state;
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
  const version =
    toFiniteNonNegativeNumber(parsed.version) ??
    toFiniteNonNegativeNumber(parsed.checkpointVersion);
  const updatedAtMs = parsed.updatedAtMs;
  const cumulativeDurationMs = toFiniteNonNegativeNumber(
    parsed.cumulativeDurationMs,
  );
  const cumulativeUsage = parseAgentTurnUsage(parsed.cumulativeUsage);
  if (
    typeof conversationId !== "string" ||
    typeof sessionId !== "string" ||
    typeof sliceId !== "number" ||
    version === undefined ||
    typeof updatedAtMs !== "number"
  ) {
    return undefined;
  }

  const legacyPiMessages = Array.isArray(parsed.piMessages)
    ? (parsed.piMessages as PiMessage[])
    : [];
  const committedMessageCount =
    toFiniteNonNegativeNumber(parsed.committedMessageCount) ??
    toFiniteNonNegativeNumber(parsed.messageCount) ??
    legacyPiMessages.length;

  return {
    legacyPiMessages,
    record: {
      version,
      conversationId,
      sessionId,
      sliceId,
      state: status,
      updatedAtMs,
      committedMessageCount,
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
    },
  };
}

function materializePiMessages(
  legacyPiMessages: PiMessage[],
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
  if (legacyPiMessages.length >= committedMessageCount) {
    return legacyPiMessages.slice(0, committedMessageCount);
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
    messageCount: parsed.record.committedMessageCount,
  });
  const sessionProjection = await loadProjection({
    conversationId,
  });
  const piMessages = materializePiMessages(
    parsed.legacyPiMessages,
    parsed.record.committedMessageCount,
    sessionMessages,
    sessionProjection,
  );
  if (!piMessages) {
    return undefined;
  }

  return materializeAgentTurnSessionRecord(parsed.record, piMessages);
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
  await commitMessages({
    conversationId: args.conversationId,
    messages: args.piMessages,
    ttlMs,
  });
  const committedMessageCount = args.piMessages.length;

  const record: StoredAgentTurnSessionRecord = {
    version: (existingRecord?.record.version ?? 0) + 1,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    updatedAtMs: Date.now(),
    committedMessageCount,
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

  await stateAdapter.set(
    agentTurnSessionKey(args.conversationId, args.sessionId),
    record,
    ttlMs,
  );
  return materializeAgentTurnSessionRecord(record, [...args.piMessages]);
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

  return await upsertAgentTurnSessionRecord({
    conversationId: existing.conversationId,
    sessionId: existing.sessionId,
    sliceId: existing.sliceId,
    state: "abandoned",
    piMessages: existing.piMessages,
    cumulativeDurationMs: existing.cumulativeDurationMs,
    cumulativeUsage: existing.cumulativeUsage,
    resumeReason: existing.resumeReason,
    resumedFromSliceId: existing.resumedFromSliceId,
    errorMessage: args.errorMessage ?? existing.errorMessage,
  });
}

/** Mark an unfinished turn session record as failed so it cannot resume. */
export async function failAgentTurnSessionRecord(args: {
  conversationId: string;
  expectedVersion?: number;
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
    (typeof args.expectedVersion === "number" &&
      existing.version !== args.expectedVersion)
  ) {
    return undefined;
  }

  return await upsertAgentTurnSessionRecord({
    conversationId: existing.conversationId,
    sessionId: existing.sessionId,
    sliceId: existing.sliceId,
    state: "failed",
    piMessages: existing.piMessages,
    cumulativeDurationMs: existing.cumulativeDurationMs,
    cumulativeUsage: existing.cumulativeUsage,
    resumeReason: existing.resumeReason,
    resumedFromSliceId: existing.resumedFromSliceId,
    errorMessage: args.errorMessage ?? existing.errorMessage,
  });
}
