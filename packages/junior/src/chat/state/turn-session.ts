/**
 * Turn session records.
 *
 * These records track one user request across auth pauses, timeout slices, and
 * completion. Full Pi messages live in the session log; this record stores
 * resumability metadata and committed message counts so resumes can materialize
 * the exact continuable boundary without duplicating the log.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import {
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { isRecord } from "@/chat/coerce";
import { parseDestination } from "@/chat/destination";
import type { PiMessage } from "@/chat/pi/messages";
import { parseActor, toStoredSlackActor, type Actor } from "@/chat/actor";
import {
  commitMessages,
  instructionActors,
  instructionProvenanceFor,
  loadMessagesWithProvenance,
  loadProjectionWithProvenance,
  parseStoredMessageProvenance,
  type PiMessageProvenance,
  type SessionProjection,
} from "./session-log";
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";
import { getConversationStore } from "@/chat/db";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type {
  ConversationExecution,
  ConversationStore,
} from "@/chat/conversations/store";
import { logWarn } from "@/chat/logging";

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

export type AgentTurnSurface = "slack" | "api" | "scheduler" | "internal";

export type AgentTurnResumeReason = "timeout" | "auth" | "yield";

export interface AgentTurnSessionRecord {
  channelName?: string;
  version: number;
  conversationId: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  errorMessage?: string;
  lastProgressAtMs: number;
  loadedSkillNames?: string[];
  piMessages: PiMessage[];
  /** Per-message provenance aligned one-to-one with `piMessages`. */
  piMessageProvenance: PiMessageProvenance[];
  /**
   * All distinct actors annotated on this run's committed instruction-authority
   * messages, in first-seen order. Derived from `piMessageProvenance` at
   * materialization — never persisted separately, so it cannot drift from
   * provenance. Attribution only; never an authority source.
   */
  actors: Actor[];
  /** The single actor this run executes as (credential binding, auth flows). */
  actor?: Actor;
  resumeReason?: AgentTurnResumeReason;
  resumedFromSliceId?: number;
  sessionId: string;
  sliceId: number;
  startedAtMs: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  traceId?: string;
  turnStartMessageIndex?: number;
  updatedAtMs: number;
}

export type AgentTurnSessionSummary = Omit<
  AgentTurnSessionRecord,
  | "errorMessage"
  | "actors"
  | "piMessages"
  | "piMessageProvenance"
  | "turnStartMessageIndex"
>;

interface StoredAgentTurnSessionRecord extends Omit<
  AgentTurnSessionRecord,
  "actors" | "piMessages" | "piMessageProvenance"
> {
  committedMessageCount: number;
  /** Provenance aligned to the committed message count, persisted for durability. */
  committedMessageProvenance: PiMessageProvenance[];
  logSessionId?: string;
}

type ParsedAgentTurnSessionFields = Omit<
  StoredAgentTurnSessionRecord,
  "committedMessageCount" | "committedMessageProvenance"
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

function toNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
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

function parseAgentTurnSurface(value: unknown): AgentTurnSurface | undefined {
  return value === "slack" ||
    value === "api" ||
    value === "scheduler" ||
    value === "internal"
    ? value
    : undefined;
}

function conversationExecutionFromSummary(
  summary: AgentTurnSessionSummary,
): ConversationExecution {
  const status =
    summary.state === "completed" || summary.state === "abandoned"
      ? "idle"
      : summary.state;
  return {
    status,
    runId: summary.sessionId,
    updatedAtMs: summary.updatedAtMs,
  };
}

function parseSource(value: unknown): Source | undefined {
  const result = sourceSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function sessionLogActor(
  actor: Actor | undefined,
): ReturnType<typeof toStoredSlackActor> | undefined {
  return actor?.platform === "slack" ? toStoredSlackActor(actor) : undefined;
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
  const conversationId = parsed.conversationId;
  const sessionId = parsed.sessionId;
  const sliceId = toFiniteNonNegativeNumber(parsed.sliceId);
  const version = toFiniteNonNegativeNumber(parsed.version);
  const updatedAtMs = toFiniteNonNegativeNumber(parsed.updatedAtMs);
  const cumulativeDurationMs =
    toFiniteNonNegativeNumber(parsed.cumulativeDurationMs) ?? 0;
  const cumulativeUsage = parseAgentTurnUsage(parsed.cumulativeUsage);
  const lastProgressAtMs = toFiniteNonNegativeNumber(parsed.lastProgressAtMs);
  const logSessionId =
    typeof parsed.logSessionId === "string" ? parsed.logSessionId : undefined;
  const actorValue =
    parsed.actor !== undefined ? parsed.actor : parsed.requester;
  const actor = actorValue === undefined ? undefined : parseActor(actorValue);
  const startedAtMs = toFiniteNonNegativeNumber(parsed.startedAtMs);
  const surface = parseAgentTurnSurface(parsed.surface);
  const turnStartMessageIndex = toNonNegativeInteger(
    parsed.turnStartMessageIndex,
  );
  const destination =
    parsed.destination === undefined
      ? undefined
      : parseDestination(parsed.destination);
  const source =
    parsed.source === undefined ? undefined : parseSource(parsed.source);
  if (
    typeof conversationId !== "string" ||
    typeof sessionId !== "string" ||
    sliceId === undefined ||
    version === undefined ||
    updatedAtMs === undefined ||
    (parsed.destination !== undefined && !destination) ||
    (parsed.source !== undefined && !source) ||
    (actorValue !== undefined && !actor)
  ) {
    return undefined;
  }

  return {
    version,
    ...(channelName ? { channelName } : {}),
    conversationId,
    sessionId,
    sliceId,
    state: status,
    startedAtMs: startedAtMs ?? updatedAtMs,
    lastProgressAtMs: lastProgressAtMs ?? updatedAtMs,
    updatedAtMs,
    cumulativeDurationMs,
    ...(logSessionId ? { logSessionId } : {}),
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
    ...(destination ? { destination } : {}),
    ...(source ? { source } : {}),
    ...(actor ? { actor } : {}),
    ...(Array.isArray(parsed.loadedSkillNames)
      ? {
          loadedSkillNames: parsed.loadedSkillNames.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(parsed.resumeReason === "timeout" ||
    parsed.resumeReason === "auth" ||
    parsed.resumeReason === "yield"
      ? { resumeReason: parsed.resumeReason }
      : {}),
    ...(typeof parsed.errorMessage === "string"
      ? { errorMessage: parsed.errorMessage }
      : {}),
    ...(typeof parsed.resumedFromSliceId === "number"
      ? { resumedFromSliceId: parsed.resumedFromSliceId }
      : {}),
    ...(surface ? { surface } : {}),
    ...(turnStartMessageIndex !== undefined ? { turnStartMessageIndex } : {}),
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
  const committedMessageProvenance = parseStoredMessageProvenance(
    parsed.committedMessageProvenance,
    committedMessageCount,
  );
  if (!committedMessageProvenance) {
    // Misaligned durable provenance fails closed rather than being zipped.
    return undefined;
  }

  return {
    ...fields,
    committedMessageCount,
    committedMessageProvenance,
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
    turnStartMessageIndex: _turnStartMessageIndex,
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

/** Store run summary metadata in the configured conversation store. */
async function recordConversationActivityMetadata(args: {
  conversationStore?: ConversationStore;
  /** Source-confirmed destination visibility from the current event's signal. */
  destinationVisibility?: ConversationPrivacy;
  nowMs: number;
  summary: AgentTurnSessionSummary;
}): Promise<void> {
  const conversationStore = args.conversationStore ?? getConversationStore();
  const source =
    args.summary.destination?.platform === "local"
      ? "local"
      : args.summary.surface;
  try {
    await conversationStore.recordActivity({
      activityAtMs: args.summary.updatedAtMs,
      channelName: args.summary.channelName,
      conversationId: args.summary.conversationId,
      destination: args.summary.destination,
      nowMs: args.nowMs,
      actor: sessionLogActor(args.summary.actor),
      source,
      visibility: args.destinationVisibility,
    });
    await conversationStore.recordExecution({
      channelName: args.summary.channelName,
      conversationId: args.summary.conversationId,
      createdAtMs: args.summary.startedAtMs,
      destination: args.summary.destination,
      execution: conversationExecutionFromSummary(args.summary),
      lastActivityAtMs: args.summary.updatedAtMs,
      actor: sessionLogActor(args.summary.actor),
      source,
      updatedAtMs: args.nowMs,
      visibility: args.destinationVisibility,
    });
  } catch (error) {
    logWarn(
      "conversation_activity_metadata_update_failed",
      { conversationId: args.summary.conversationId },
      {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      },
      "Failed to update conversation activity metadata",
    );
  }
}

/**
 * Rehydrate the continuable Pi boundary from the session log, tolerating a
 * compacted projection when the exact historical prefix is no longer visible.
 */
function materializePiProjection(
  committedMessageCount: number,
  includeProjectionTail: boolean,
  sessionMessages: SessionProjection | undefined,
  sessionProjection: SessionProjection,
): SessionProjection | undefined {
  if (committedMessageCount === 0) {
    return sessionProjection;
  }
  if (
    includeProjectionTail &&
    sessionProjection.messages.length >= committedMessageCount
  ) {
    return sessionProjection;
  }
  if (sessionMessages) {
    return sessionMessages;
  }
  if (sessionProjection.messages.length >= committedMessageCount) {
    return {
      messages: sessionProjection.messages.slice(0, committedMessageCount),
      provenance: sessionProjection.provenance.slice(0, committedMessageCount),
    };
  }
  return undefined;
}

function materializeAgentTurnSessionRecord(
  stored: StoredAgentTurnSessionRecord,
  piProjection: SessionProjection,
): AgentTurnSessionRecord {
  return {
    version: stored.version,
    ...(stored.channelName ? { channelName: stored.channelName } : {}),
    conversationId: stored.conversationId,
    sessionId: stored.sessionId,
    sliceId: stored.sliceId,
    state: stored.state,
    startedAtMs: stored.startedAtMs,
    lastProgressAtMs: stored.lastProgressAtMs,
    updatedAtMs: stored.updatedAtMs,
    piMessages: piProjection.messages,
    piMessageProvenance: piProjection.provenance,
    actors: instructionActors(piProjection.provenance),
    cumulativeDurationMs: stored.cumulativeDurationMs,
    ...(stored.destination ? { destination: stored.destination } : {}),
    ...(stored.source ? { source: stored.source } : {}),
    ...(stored.cumulativeUsage
      ? { cumulativeUsage: stored.cumulativeUsage }
      : {}),
    ...(stored.resumeReason ? { resumeReason: stored.resumeReason } : {}),
    ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {}),
    ...(stored.loadedSkillNames
      ? { loadedSkillNames: stored.loadedSkillNames }
      : {}),
    ...(stored.actor ? { actor: stored.actor } : {}),
    ...(stored.resumedFromSliceId !== undefined
      ? { resumedFromSliceId: stored.resumedFromSliceId }
      : {}),
    ...(stored.surface ? { surface: stored.surface } : {}),
    ...(stored.traceId ? { traceId: stored.traceId } : {}),
    ...(stored.turnStartMessageIndex !== undefined
      ? { turnStartMessageIndex: stored.turnStartMessageIndex }
      : {}),
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

  const sessionMessages = await loadMessagesWithProvenance({
    conversationId,
    messageCount: parsed.committedMessageCount,
    ...(parsed.logSessionId ? { sessionId: parsed.logSessionId } : {}),
  });
  const sessionProjection = await loadProjectionWithProvenance({
    conversationId,
    ...(parsed.logSessionId ? { sessionId: parsed.logSessionId } : {}),
  });
  const piProjection = materializePiProjection(
    parsed.committedMessageCount,
    parsed.state === "running" || parsed.state === "awaiting_resume",
    sessionMessages,
    sessionProjection,
  );
  if (!piProjection) {
    return undefined;
  }

  return materializeAgentTurnSessionRecord(parsed, piProjection);
}

/** Build the storage record that advances optimistic resume versioning. */
function buildStoredRecord(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  committedMessageCount: number;
  committedMessageProvenance: PiMessageProvenance[];
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  logSessionId?: string;
  previousVersion?: number;
  actor?: Actor;
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  turnStartMessageIndex?: number;
}): StoredAgentTurnSessionRecord {
  const nowMs = Date.now();
  return {
    version: (args.previousVersion ?? 0) + 1,
    ...(args.channelName ? { channelName: args.channelName } : {}),
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    startedAtMs: args.startedAtMs ?? nowMs,
    lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
    updatedAtMs: nowMs,
    committedMessageCount: args.committedMessageCount,
    committedMessageProvenance: args.committedMessageProvenance,
    ...(args.logSessionId ? { logSessionId: args.logSessionId } : {}),
    cumulativeDurationMs: args.cumulativeDurationMs,
    ...(args.cumulativeUsage ? { cumulativeUsage: args.cumulativeUsage } : {}),
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.actor ? { actor: args.actor } : {}),
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
    ...(args.surface ? { surface: args.surface } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
    ...(args.turnStartMessageIndex !== undefined
      ? { turnStartMessageIndex: args.turnStartMessageIndex }
      : {}),
  };
}

async function setStoredRecord(args: {
  conversationStore?: ConversationStore;
  /** Source-confirmed destination visibility from the current event's signal. */
  destinationVisibility?: ConversationPrivacy;
  piMessages: PiMessage[];
  piMessageProvenance: PiMessageProvenance[];
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
    committedMessageProvenance: _committedMessageProvenance,
    errorMessage: _errorMessage,
    logSessionId: _logSessionId,
    turnStartMessageIndex: _turnStartMessageIndex,
    ...summary
  } = args.record;
  await appendAgentTurnSessionSummary(summary, args.ttlMs);
  await recordConversationActivityMetadata({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    nowMs: Date.now(),
    summary,
  });
  return materializeAgentTurnSessionRecord(args.record, {
    messages: [...args.piMessages],
    provenance: [...args.piMessageProvenance],
  });
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
    piMessageProvenance: args.existing.piMessageProvenance,
    ttlMs: AGENT_TURN_SESSION_TTL_MS,
    record: buildStoredRecord({
      conversationId: args.existing.conversationId,
      sessionId: args.existing.sessionId,
      sliceId: args.existing.sliceId,
      state: args.state,
      committedMessageCount: parsed.committedMessageCount,
      committedMessageProvenance: parsed.committedMessageProvenance,
      ...(parsed.channelName ? { channelName: parsed.channelName } : {}),
      startedAtMs: parsed.startedAtMs,
      lastProgressAtMs: parsed.lastProgressAtMs,
      previousVersion: parsed.version,
      ...(parsed.logSessionId ? { logSessionId: parsed.logSessionId } : {}),
      cumulativeDurationMs: args.existing.cumulativeDurationMs,
      ...(args.existing.cumulativeUsage
        ? { cumulativeUsage: args.existing.cumulativeUsage }
        : {}),
      ...(args.existing.destination
        ? { destination: args.existing.destination }
        : {}),
      ...(args.existing.source ? { source: args.existing.source } : {}),
      ...(args.existing.loadedSkillNames
        ? { loadedSkillNames: args.existing.loadedSkillNames }
        : {}),
      ...(args.existing.actor ? { actor: args.existing.actor } : {}),
      ...(args.existing.resumeReason
        ? { resumeReason: args.existing.resumeReason }
        : {}),
      ...(args.existing.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.existing.resumedFromSliceId }
        : {}),
      ...(args.existing.surface ? { surface: args.existing.surface } : {}),
      ...(args.existing.traceId ? { traceId: args.existing.traceId } : {}),
      ...(args.existing.turnStartMessageIndex !== undefined
        ? { turnStartMessageIndex: args.existing.turnStartMessageIndex }
        : {}),
      ...((args.errorMessage ?? args.existing.errorMessage)
        ? { errorMessage: args.errorMessage ?? args.existing.errorMessage }
        : {}),
    }),
  });
}

/** Commit stable Pi session state and advance the turn session record. */
export async function upsertAgentTurnSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  /** Source-confirmed destination visibility from the current event's signal. */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  conversationStore?: ConversationStore;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  piMessages: PiMessage[];
  /** Provenance for trailing newly committed messages, such as steering. */
  trailingMessageProvenance?: PiMessageProvenance[];
  actor?: Actor;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  turnStartMessageIndex?: number;
  ttlMs?: number;
}): Promise<AgentTurnSessionRecord> {
  const existingRecord = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  // Attribute new user input to the turn's actor as an instruction; the session
  // log reuses committed provenance for the unchanged prefix and defaults the
  // rest to context. Platform-neutral so local identities are preserved too.
  const instructionActor = args.actor ?? existingRecord?.actor;
  const commit = await commitMessages({
    conversationId: args.conversationId,
    messages: args.piMessages,
    ...(instructionActor
      ? { newMessageProvenance: instructionProvenanceFor(instructionActor) }
      : {}),
    ...(args.trailingMessageProvenance
      ? { trailingMessageProvenance: args.trailingMessageProvenance }
      : {}),
    ttlMs,
  });

  return await setStoredRecord({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    piMessages: args.piMessages,
    piMessageProvenance: commit.provenance,
    ttlMs,
    record: buildStoredRecord({
      committedMessageProvenance: commit.provenance,
      ...((args.channelName ?? existingRecord?.channelName)
        ? { channelName: args.channelName ?? existingRecord?.channelName }
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
      cumulativeDurationMs:
        toFiniteNonNegativeNumber(args.cumulativeDurationMs) ??
        existingRecord?.cumulativeDurationMs ??
        0,
      ...(args.cumulativeUsage
        ? { cumulativeUsage: args.cumulativeUsage }
        : {}),
      ...((args.destination ?? existingRecord?.destination)
        ? { destination: args.destination ?? existingRecord?.destination }
        : {}),
      ...((args.source ?? existingRecord?.source)
        ? { source: args.source ?? existingRecord?.source }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...((args.actor ?? existingRecord?.actor)
        ? { actor: args.actor ?? existingRecord?.actor }
        : {}),
      ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.resumedFromSliceId }
        : {}),
      ...((args.surface ?? existingRecord?.surface)
        ? { surface: args.surface ?? existingRecord?.surface }
        : {}),
      ...((args.traceId ?? existingRecord?.traceId)
        ? { traceId: args.traceId ?? existingRecord?.traceId }
        : {}),
      ...((args.turnStartMessageIndex ??
        existingRecord?.turnStartMessageIndex) !== undefined
        ? {
            turnStartMessageIndex:
              args.turnStartMessageIndex ??
              existingRecord?.turnStartMessageIndex,
          }
        : {}),
    }),
  });
}

/** Record turn-session metadata without storing conversation messages. */
export async function recordAgentTurnSessionSummary(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  /**
   * Source-confirmed destination visibility from the current event's signal
   * (Slack `channel_type`). Leave unset when no live signal exists so an
   * existing destination visibility is not overwritten.
   */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  conversationStore?: ConversationStore;
  actor?: Actor;
  resumeReason?: AgentTurnResumeReason;
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  traceId?: string;
  ttlMs?: number;
}): Promise<void> {
  const existing = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  const nowMs = Date.now();
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  const summary: AgentTurnSessionSummary = {
    version: existing?.version ?? 0,
    ...((args.channelName ?? existing?.channelName)
      ? { channelName: args.channelName ?? existing?.channelName }
      : {}),
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    startedAtMs: existing?.startedAtMs ?? args.startedAtMs ?? nowMs,
    lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
    state: args.state,
    updatedAtMs: nowMs,
    cumulativeDurationMs:
      toFiniteNonNegativeNumber(args.cumulativeDurationMs) ??
      existing?.cumulativeDurationMs ??
      0,
    ...((args.cumulativeUsage ?? existing?.cumulativeUsage)
      ? { cumulativeUsage: args.cumulativeUsage ?? existing?.cumulativeUsage }
      : {}),
    ...((args.destination ?? existing?.destination)
      ? { destination: args.destination ?? existing?.destination }
      : {}),
    ...((args.source ?? existing?.source)
      ? { source: args.source ?? existing?.source }
      : {}),
    ...((args.actor ?? existing?.actor)
      ? { actor: args.actor ?? existing?.actor }
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
    ...((args.surface ?? existing?.surface)
      ? { surface: args.surface ?? existing?.surface }
      : {}),
    ...((args.traceId ?? existing?.traceId)
      ? { traceId: args.traceId ?? existing?.traceId }
      : {}),
  };
  await appendAgentTurnSessionSummary(summary, ttlMs);
  await recordConversationActivityMetadata({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    nowMs,
    summary,
  });
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
