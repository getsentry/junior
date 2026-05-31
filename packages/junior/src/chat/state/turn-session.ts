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
const AGENT_TURN_SESSION_INDEX_KEY = `${AGENT_TURN_SESSION_PREFIX}:index`;
const AGENT_TURN_SESSION_INDEX_MAX_LENGTH = 5_000;
const AGENT_TURN_SESSION_TTL_MS = THREAD_STATE_TTL_MS;

export type AgentTurnSessionStatus =
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "abandoned";

export type AgentTurnResumeReason = "timeout" | "auth";

export interface AgentTurnRequester {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface AgentTurnSessionRecord {
  channelName?: string;
  conversationTitle?: string;
  version: number;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  errorMessage?: string;
  lastProgressAtMs: number;
  loadedSkillNames?: string[];
  piMessages: PiMessage[];
  requester?: AgentTurnRequester;
  resumeReason?: AgentTurnResumeReason;
  resumedFromSliceId?: number;
  sessionId: string;
  sliceId: number;
  startedAtMs: number;
  state: AgentTurnSessionStatus;
  traceId?: string;
  updatedAtMs: number;
}

export type AgentTurnSessionSummary = Omit<
  AgentTurnSessionRecord,
  "errorMessage" | "piMessages"
>;

interface StoredAgentTurnSessionRecord extends Omit<
  AgentTurnSessionRecord,
  "piMessages"
> {
  committedMessageCount: number;
  logSessionId?: string;
}

type ParsedAgentTurnSessionFields = Omit<
  StoredAgentTurnSessionRecord,
  "committedMessageCount"
>;

function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

function agentTurnSessionConversationIndexKey(conversationId: string): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
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

function parseAgentTurnRequester(
  value: unknown,
): AgentTurnRequester | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const requester: AgentTurnRequester = {};
  for (const field of [
    "email",
    "fullName",
    "slackUserId",
    "slackUserName",
  ] as const) {
    if (typeof value[field] === "string" && value[field].trim()) {
      requester[field] = value[field].trim();
    }
  }

  return Object.keys(requester).length > 0 ? requester : undefined;
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

function parseAgentTurnSessionStatus(
  parsed: Record<string, unknown>,
): AgentTurnSessionStatus | undefined {
  const status = parsed.state;
  if (
    status === "running" ||
    status === "awaiting_resume" ||
    status === "completed" ||
    status === "failed" ||
    status === "abandoned"
  ) {
    return status;
  }
  return undefined;
}

function parseAgentTurnSessionFields(
  parsed: Record<string, unknown>,
): ParsedAgentTurnSessionFields | undefined {
  const status = parseAgentTurnSessionStatus(parsed);
  if (!status) {
    return undefined;
  }

  const channelName =
    typeof parsed.channelName === "string" && parsed.channelName.trim()
      ? parsed.channelName.trim()
      : undefined;
  const conversationTitle =
    typeof parsed.conversationTitle === "string" &&
    parsed.conversationTitle.trim()
      ? parsed.conversationTitle.trim()
      : undefined;
  const conversationId = parsed.conversationId;
  const sessionId = parsed.sessionId;
  const sliceId = toFiniteNonNegativeNumber(parsed.sliceId);
  const version = toFiniteNonNegativeNumber(parsed.version);
  const updatedAtMs = toFiniteNonNegativeNumber(parsed.updatedAtMs);
  const cumulativeDurationMs = toFiniteNonNegativeNumber(
    parsed.cumulativeDurationMs,
  );
  const cumulativeUsage = parseAgentTurnUsage(parsed.cumulativeUsage);
  const lastProgressAtMs = toFiniteNonNegativeNumber(parsed.lastProgressAtMs);
  const logSessionId =
    typeof parsed.logSessionId === "string" ? parsed.logSessionId : undefined;
  const requester = parseAgentTurnRequester(parsed.requester);
  const startedAtMs = toFiniteNonNegativeNumber(parsed.startedAtMs);
  if (
    typeof conversationId !== "string" ||
    typeof sessionId !== "string" ||
    sliceId === undefined ||
    version === undefined ||
    updatedAtMs === undefined
  ) {
    return undefined;
  }

  return {
    version,
    ...(channelName ? { channelName } : {}),
    ...(conversationTitle ? { conversationTitle } : {}),
    conversationId,
    sessionId,
    sliceId,
    state: status,
    startedAtMs: startedAtMs ?? updatedAtMs,
    lastProgressAtMs: lastProgressAtMs ?? updatedAtMs,
    updatedAtMs,
    ...(logSessionId ? { logSessionId } : {}),
    ...(cumulativeDurationMs !== undefined ? { cumulativeDurationMs } : {}),
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
    ...(requester ? { requester } : {}),
    ...(Array.isArray(parsed.loadedSkillNames)
      ? {
          loadedSkillNames: parsed.loadedSkillNames.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(parsed.resumeReason === "timeout" || parsed.resumeReason === "auth"
      ? { resumeReason: parsed.resumeReason }
      : {}),
    ...(typeof parsed.errorMessage === "string"
      ? { errorMessage: parsed.errorMessage }
      : {}),
    ...(typeof parsed.resumedFromSliceId === "number"
      ? { resumedFromSliceId: parsed.resumedFromSliceId }
      : {}),
    ...(typeof parsed.traceId === "string" ? { traceId: parsed.traceId } : {}),
  };
}

function parseAgentTurnSessionRecord(
  value: unknown,
): StoredAgentTurnSessionRecord | undefined {
  const parsed = parseStoredRecord(value);
  if (!parsed) {
    return undefined;
  }

  const fields = parseAgentTurnSessionFields(parsed);
  const committedMessageCount = toFiniteNonNegativeNumber(
    parsed.committedMessageCount,
  );
  if (!fields || committedMessageCount === undefined) {
    return undefined;
  }

  return {
    ...fields,
    committedMessageCount,
  };
}

function parseAgentTurnSessionSummary(
  value: unknown,
): AgentTurnSessionSummary | undefined {
  const stored = parseStoredRecord(value);
  if (!stored) {
    return undefined;
  }
  const parsed = parseAgentTurnSessionFields(stored);
  if (!parsed) {
    return undefined;
  }

  const {
    errorMessage: _errorMessage,
    logSessionId: _logSessionId,
    ...summary
  } = parsed;
  return summary;
}

async function appendAgentTurnSessionSummary(
  summary: AgentTurnSessionSummary,
  ttlMs: number,
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await Promise.all([
    stateAdapter.appendToList(AGENT_TURN_SESSION_INDEX_KEY, summary, {
      maxLength: AGENT_TURN_SESSION_INDEX_MAX_LENGTH,
      ttlMs,
    }),
    stateAdapter.appendToList(
      agentTurnSessionConversationIndexKey(summary.conversationId),
      summary,
      { ttlMs },
    ),
  ]);
}

/**
 * Rehydrate the continuable Pi boundary from the session log, tolerating a
 * compacted projection when the exact historical prefix is no longer visible.
 */
function materializePiMessages(
  committedMessageCount: number,
  includeProjectionTail: boolean,
  sessionMessages: PiMessage[] | undefined,
  sessionProjection: PiMessage[],
): PiMessage[] | undefined {
  if (committedMessageCount === 0) {
    return sessionProjection;
  }
  if (
    includeProjectionTail &&
    sessionProjection.length >= committedMessageCount
  ) {
    return sessionProjection;
  }
  if (sessionMessages) {
    return sessionMessages;
  }
  if (sessionProjection.length >= committedMessageCount) {
    return sessionProjection.slice(0, committedMessageCount);
  }
  return undefined;
}

function materializeAgentTurnSessionRecord(
  stored: StoredAgentTurnSessionRecord,
  piMessages: PiMessage[],
): AgentTurnSessionRecord {
  return {
    version: stored.version,
    ...(stored.channelName ? { channelName: stored.channelName } : {}),
    ...(stored.conversationTitle
      ? { conversationTitle: stored.conversationTitle }
      : {}),
    conversationId: stored.conversationId,
    sessionId: stored.sessionId,
    sliceId: stored.sliceId,
    state: stored.state,
    startedAtMs: stored.startedAtMs,
    lastProgressAtMs: stored.lastProgressAtMs,
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
    ...(stored.loadedSkillNames
      ? { loadedSkillNames: stored.loadedSkillNames }
      : {}),
    ...(stored.requester ? { requester: stored.requester } : {}),
    ...(stored.resumedFromSliceId !== undefined
      ? { resumedFromSliceId: stored.resumedFromSliceId }
      : {}),
    ...(stored.traceId ? { traceId: stored.traceId } : {}),
  };
}

/** Read only the stored metadata record without materializing transcript logs. */
async function getStoredAgentTurnSessionRecord(
  conversationId: string,
  sessionId: string,
): Promise<StoredAgentTurnSessionRecord | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const value = await stateAdapter.get(
    agentTurnSessionKey(conversationId, sessionId),
  );
  return parseAgentTurnSessionRecord(value);
}

/** Read a materialized turn session record for resume and history loading. */
export async function getAgentTurnSessionRecord(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionRecord | undefined> {
  const parsed = await getStoredAgentTurnSessionRecord(
    conversationId,
    sessionId,
  );
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
    parsed.state === "running" || parsed.state === "awaiting_resume",
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
  channelName?: string;
  conversationTitle?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  committedMessageCount: number;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  logSessionId?: string;
  previousVersion?: number;
  requester?: AgentTurnRequester;
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
}): StoredAgentTurnSessionRecord {
  const nowMs = Date.now();
  return {
    version: (args.previousVersion ?? 0) + 1,
    ...(args.channelName ? { channelName: args.channelName } : {}),
    ...(args.conversationTitle
      ? { conversationTitle: args.conversationTitle }
      : {}),
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    startedAtMs: args.startedAtMs ?? nowMs,
    lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
    updatedAtMs: nowMs,
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
    ...(args.requester ? { requester: args.requester } : {}),
    ...(Array.isArray(args.loadedSkillNames)
      ? {
          loadedSkillNames: args.loadedSkillNames.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(typeof args.resumedFromSliceId === "number"
      ? { resumedFromSliceId: args.resumedFromSliceId }
      : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
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
  const {
    committedMessageCount: _committedMessageCount,
    errorMessage: _errorMessage,
    logSessionId: _logSessionId,
    ...summary
  } = args.record;
  await appendAgentTurnSessionSummary(summary, args.ttlMs);
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
  const parsed = await getStoredAgentTurnSessionRecord(
    args.existing.conversationId,
    args.existing.sessionId,
  );
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
      ...(parsed.channelName ? { channelName: parsed.channelName } : {}),
      ...(parsed.conversationTitle
        ? { conversationTitle: parsed.conversationTitle }
        : {}),
      startedAtMs: parsed.startedAtMs,
      lastProgressAtMs: parsed.lastProgressAtMs,
      previousVersion: parsed.version,
      ...(parsed.logSessionId ? { logSessionId: parsed.logSessionId } : {}),
      ...(args.existing.cumulativeDurationMs !== undefined
        ? { cumulativeDurationMs: args.existing.cumulativeDurationMs }
        : {}),
      ...(args.existing.cumulativeUsage
        ? { cumulativeUsage: args.existing.cumulativeUsage }
        : {}),
      ...(args.existing.loadedSkillNames
        ? { loadedSkillNames: args.existing.loadedSkillNames }
        : {}),
      ...(args.existing.requester
        ? { requester: args.existing.requester }
        : {}),
      ...(args.existing.resumeReason
        ? { resumeReason: args.existing.resumeReason }
        : {}),
      ...(args.existing.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.existing.resumedFromSliceId }
        : {}),
      ...(args.existing.traceId ? { traceId: args.existing.traceId } : {}),
      ...((args.errorMessage ?? args.existing.errorMessage)
        ? { errorMessage: args.errorMessage ?? args.existing.errorMessage }
        : {}),
    }),
  });
}

/** Commit stable Pi session state and advance the turn session record. */
export async function upsertAgentTurnSessionRecord(args: {
  channelName?: string;
  conversationTitle?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  piMessages: PiMessage[];
  requester?: AgentTurnRequester;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  ttlMs?: number;
}): Promise<AgentTurnSessionRecord> {
  const existingRecord = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
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
      ...((args.channelName ?? existingRecord?.channelName)
        ? { channelName: args.channelName ?? existingRecord?.channelName }
        : {}),
      ...((args.conversationTitle ?? existingRecord?.conversationTitle)
        ? {
            conversationTitle:
              args.conversationTitle ?? existingRecord?.conversationTitle,
          }
        : {}),
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: args.state,
      ...(existingRecord?.startedAtMs !== undefined
        ? { startedAtMs: existingRecord.startedAtMs }
        : {}),
      ...(args.lastProgressAtMs !== undefined
        ? { lastProgressAtMs: args.lastProgressAtMs }
        : {}),
      committedMessageCount: args.piMessages.length,
      logSessionId: commit.sessionId,
      previousVersion: existingRecord?.version,
      ...(args.cumulativeDurationMs !== undefined
        ? { cumulativeDurationMs: args.cumulativeDurationMs }
        : {}),
      ...(args.cumulativeUsage
        ? { cumulativeUsage: args.cumulativeUsage }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...((args.requester ?? existingRecord?.requester)
        ? { requester: args.requester ?? existingRecord?.requester }
        : {}),
      ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.resumedFromSliceId }
        : {}),
      ...((args.traceId ?? existingRecord?.traceId)
        ? { traceId: args.traceId ?? existingRecord?.traceId }
        : {}),
    }),
  });
}

/** Record turn-session metadata without storing conversation messages. */
export async function recordAgentTurnSessionSummary(args: {
  channelName?: string;
  conversationTitle?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  requester?: AgentTurnRequester;
  resumeReason?: AgentTurnResumeReason;
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  traceId?: string;
  ttlMs?: number;
}): Promise<void> {
  const existing = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  const nowMs = Date.now();
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  await appendAgentTurnSessionSummary(
    {
      version: existing?.version ?? 0,
      ...((args.channelName ?? existing?.channelName)
        ? { channelName: args.channelName ?? existing?.channelName }
        : {}),
      ...((args.conversationTitle ?? existing?.conversationTitle)
        ? {
            conversationTitle:
              args.conversationTitle ?? existing?.conversationTitle,
          }
        : {}),
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      startedAtMs: existing?.startedAtMs ?? args.startedAtMs ?? nowMs,
      lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
      state: args.state,
      updatedAtMs: nowMs,
      ...(typeof args.cumulativeDurationMs === "number" &&
      Number.isFinite(args.cumulativeDurationMs)
        ? {
            cumulativeDurationMs: Math.max(
              0,
              Math.floor(args.cumulativeDurationMs),
            ),
          }
        : existing?.cumulativeDurationMs !== undefined
          ? { cumulativeDurationMs: existing.cumulativeDurationMs }
          : {}),
      ...((args.cumulativeUsage ?? existing?.cumulativeUsage)
        ? { cumulativeUsage: args.cumulativeUsage ?? existing?.cumulativeUsage }
        : {}),
      ...((args.requester ?? existing?.requester)
        ? { requester: args.requester ?? existing?.requester }
        : {}),
      ...(Array.isArray(args.loadedSkillNames)
        ? {
            loadedSkillNames: args.loadedSkillNames.filter(
              (value): value is string => typeof value === "string",
            ),
          }
        : existing?.loadedSkillNames
          ? { loadedSkillNames: existing.loadedSkillNames }
          : {}),
      ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
      ...((args.traceId ?? existing?.traceId)
        ? { traceId: args.traceId ?? existing?.traceId }
        : {}),
    },
    ttlMs,
  );
}

async function readAgentTurnSessionSummariesFromIndex(
  key: string,
): Promise<AgentTurnSessionSummary[]> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const values = await stateAdapter.getList(key);
  const summaries = new Map<string, AgentTurnSessionSummary>();

  for (const value of [...values].reverse()) {
    const summary = parseAgentTurnSessionSummary(value);
    if (!summary) {
      continue;
    }
    const key = `${summary.conversationId}:${summary.sessionId}`;
    if (!summaries.has(key)) {
      summaries.set(key, summary);
    }
  }

  return [...summaries.values()].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

/** List recent turn-session summaries for authenticated operational dashboards. */
export async function listAgentTurnSessionSummaries(
  limit = 50,
): Promise<AgentTurnSessionSummary[]> {
  return (
    await readAgentTurnSessionSummariesFromIndex(AGENT_TURN_SESSION_INDEX_KEY)
  ).slice(0, Math.max(0, Math.floor(limit)));
}

/** List turn-session summaries for one conversation without the global feed cap. */
export async function listAgentTurnSessionSummariesForConversation(
  conversationId: string,
): Promise<AgentTurnSessionSummary[]> {
  const summaries = await readAgentTurnSessionSummariesFromIndex(
    agentTurnSessionConversationIndexKey(conversationId),
  );
  if (summaries.length > 0) {
    return summaries;
  }

  return (
    await readAgentTurnSessionSummariesFromIndex(AGENT_TURN_SESSION_INDEX_KEY)
  ).filter((summary) => summary.conversationId === conversationId);
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
