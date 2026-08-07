/**
 * Turn session records.
 *
 * These records track one user request across auth pauses, timeout slices, and
 * completion. Full Pi messages live in the durable conversation event store; this
 * record stores resumability metadata and a committed `seq` cursor into
 * `junior_conversation_events` so resumes can materialize the exact continuable
 * boundary without duplicating the event history.
 */
import { THREAD_STATE_TTL_MS, type StateAdapter } from "chat";
import {
  actorSchema,
  destinationSchema,
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { toStoredSlackActor, type Actor } from "@/chat/actor";
import {
  contextProvenance,
  instructionActors,
  instructionProvenanceFor,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  commitMessages,
  loadTurnProjection,
} from "@/chat/conversations/projection";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { agentTurnUsageSchema, type AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { isAgentsInstructionsMessage } from "@/chat/repository-instructions";
import {
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type {
  ConversationExecution,
  ConversationStore,
} from "@/chat/conversations/store";
import {
  AGENT_TURN_SESSION_PREFIX,
  agentTurnSessionConversationIndexKey,
  agentTurnSessionKey,
} from "./turn-session-keys";

const AGENT_TURN_SESSION_INDEX_KEY = `${AGENT_TURN_SESSION_PREFIX}:index`;
const AGENT_TURN_SESSION_INDEX_MAX_LENGTH = 5_000;
const AGENT_TURN_SESSION_INDEX_READ_CONCURRENCY = 25;
const AGENT_TURN_SESSION_TTL_MS = THREAD_STATE_TTL_MS;

export type AgentTurnSessionStatus =
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "abandoned";

export type AgentTurnSurface = "slack" | "api" | "scheduler" | "internal";

export type AgentTurnResumeReason = "timeout" | "auth" | "yield" | "retry";
export type AgentDispatchOutcome = "blocked" | "completed" | "failed";

interface ConversationMessageProjection {
  messages: PiMessage[];
  provenance: ConversationMessageProvenance[];
}

export interface AgentTurnSessionRecord {
  channelName?: string;
  version: number;
  conversationId: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
  source?: Source;
  errorMessage?: string;
  lastProgressAtMs: number;
  loadedSkillNames?: string[];
  modelId?: string;
  reasoningLevel?: string;
  piMessages: PiMessage[];
  /** Per-message provenance aligned one-to-one with `piMessages`. */
  piMessageProvenance: ConversationMessageProvenance[];
  /**
   * All distinct actors annotated on this run's committed instruction-authority
   * messages, in first-seen order. Persisted as an attribution handle so a
   * summary-only handoff cannot erase them. It never grants authority or
   * replaces the singular execution actor.
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
  "actors" | "piMessages" | "piMessageProvenance" | "turnStartMessageIndex"
> {
  actors?: Actor[];
  /**
   * `seq` of the last event in `junior_conversation_events` whose projection reproduces
   * this record's committed Pi messages; -1 when nothing was committed.
   */
  committedSeq: number;
  /** History version that owns `committedSeq` and any volatile bootstrap. */
  historyVersion?: number;
  /**
   * `seq` boundary where this turn's fresh prompt starts: the seq of the last
   * projected message before the prompt, or -1 when the turn starts the epoch.
   */
  turnStartSeq?: number;
  /** Volatile bootstrap retained only in resumable session state, never SQL. */
  runtimeContext?: PiMessage[];
}

const agentTurnSessionStatusSchema = z.enum([
  "running",
  "awaiting_resume",
  "completed",
  "failed",
  "abandoned",
]) satisfies z.ZodType<AgentTurnSessionStatus>;

const agentTurnSurfaceSchema = z.enum([
  "slack",
  "api",
  "scheduler",
  "internal",
]) satisfies z.ZodType<AgentTurnSurface>;

const agentTurnResumeReasonSchema = z.enum([
  "timeout",
  "auth",
  "yield",
  "retry",
]) satisfies z.ZodType<AgentTurnResumeReason>;

const nonNegativeNumberSchema = z.number().finite().nonnegative();
const seqCursorSchema = z.number().int().min(-1);
const agentTurnSessionSummarySchema = z
  .object({
    channelName: z.string().min(1).optional(),
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    cumulativeDurationMs: nonNegativeNumberSchema,
    cumulativeUsage: agentTurnUsageSchema.optional(),
    // TODO(#1267): Remove destination/source and their Redis write paths once
    // SQL-only readers are deployed; existing records do not need to expire.
    destination: destinationSchema.optional(),
    dispatchId: z.string().min(1).optional(),
    dispatchOutcome: z.enum(["blocked", "completed", "failed"]).optional(),
    resultMessageId: z.string().min(1).optional(),
    source: sourceSchema.optional(),
    lastProgressAtMs: nonNegativeNumberSchema,
    loadedSkillNames: z.array(z.string()).optional(),
    modelId: z.string().min(1).optional(),
    reasoningLevel: z.string().min(1).optional(),
    actor: actorSchema.optional(),
    resumeReason: agentTurnResumeReasonSchema.optional(),
    resumedFromSliceId: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1),
    sliceId: z.number().int().nonnegative(),
    startedAtMs: nonNegativeNumberSchema,
    state: agentTurnSessionStatusSchema,
    surface: agentTurnSurfaceSchema.optional(),
    traceId: z.string().optional(),
    updatedAtMs: nonNegativeNumberSchema,
  })
  .strict() satisfies z.ZodType<AgentTurnSessionSummary>;

const storedAgentTurnSessionRecordSchema = agentTurnSessionSummarySchema
  .extend({
    actors: z.array(actorSchema).optional(),
    committedSeq: seqCursorSchema,
    historyVersion: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    turnStartSeq: seqCursorSchema.optional(),
    runtimeContext: z.array(piMessageSchema).optional(),
  })
  .strict() satisfies z.ZodType<StoredAgentTurnSessionRecord>;

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

function sessionLogActor(
  actor: Actor | undefined,
): ReturnType<typeof toStoredSlackActor> | undefined {
  return actor?.platform === "slack" ? toStoredSlackActor(actor) : undefined;
}

function parseAgentTurnSessionRecord(
  value: unknown,
): StoredAgentTurnSessionRecord {
  return storedAgentTurnSessionRecordSchema.parse(value);
}

function parseAgentTurnSessionSummary(value: unknown): AgentTurnSessionSummary {
  return agentTurnSessionSummarySchema.parse(value);
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
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  nowMs: number;
  summary: AgentTurnSessionSummary;
}): Promise<void> {
  const conversationStore = args.conversationStore ?? getConversationStore();
  const conversation = await conversationStore.get({
    conversationId: args.summary.conversationId,
  });
  const isChild = Boolean(conversation?.lineage);
  const destination = isChild ? undefined : args.summary.destination;
  const source = isChild
    ? "internal"
    : destination?.platform === "local"
      ? "local"
      : args.summary.surface;
  await conversationStore.recordActivity({
    activityAtMs: args.summary.updatedAtMs,
    channelName: args.summary.channelName,
    conversationId: args.summary.conversationId,
    destination,
    nowMs: args.nowMs,
    actor: sessionLogActor(args.summary.actor),
    source,
    ...(args.summary.source ? { sessionSource: args.summary.source } : {}),
    visibility: isChild ? undefined : args.destinationVisibility,
  });
  await conversationStore.recordExecution({
    channelName: args.summary.channelName,
    conversationId: args.summary.conversationId,
    createdAtMs: args.summary.startedAtMs,
    destination,
    execution: conversationExecutionFromSummary(args.summary),
    lastActivityAtMs: args.summary.updatedAtMs,
    metrics: {
      durationMs: args.summary.cumulativeDurationMs,
      ...(args.summary.cumulativeUsage
        ? { usage: args.summary.cumulativeUsage }
        : {}),
    },
    actor: sessionLogActor(args.summary.actor),
    source,
    updatedAtMs: args.nowMs,
    visibility: isChild ? undefined : args.destinationVisibility,
  });
}

function materializeAgentTurnSessionRecord(
  stored: StoredAgentTurnSessionRecord,
  piProjection: ConversationMessageProjection,
  turnStartMessageIndex?: number,
  restoreVolatileContext = true,
): AgentTurnSessionRecord {
  const restoredProjection =
    restoreVolatileContext &&
    (stored.state === "running" || stored.state === "awaiting_resume")
      ? restoreRuntimeContext(piProjection, stored.runtimeContext)
      : piProjection;
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
    piMessages: restoredProjection.messages,
    piMessageProvenance: restoredProjection.provenance,
    actors: stored.actors ?? instructionActors(piProjection.provenance),
    cumulativeDurationMs: stored.cumulativeDurationMs,
    ...(stored.destination ? { destination: stored.destination } : {}),
    ...(stored.dispatchId ? { dispatchId: stored.dispatchId } : {}),
    ...(stored.dispatchOutcome
      ? { dispatchOutcome: stored.dispatchOutcome }
      : {}),
    ...(stored.resultMessageId
      ? { resultMessageId: stored.resultMessageId }
      : {}),
    ...(stored.source ? { source: stored.source } : {}),
    ...(stored.cumulativeUsage
      ? { cumulativeUsage: stored.cumulativeUsage }
      : {}),
    ...(stored.resumeReason ? { resumeReason: stored.resumeReason } : {}),
    ...(stored.errorMessage ? { errorMessage: stored.errorMessage } : {}),
    ...(stored.loadedSkillNames
      ? { loadedSkillNames: stored.loadedSkillNames }
      : {}),
    ...(stored.modelId ? { modelId: stored.modelId } : {}),
    ...(stored.reasoningLevel ? { reasoningLevel: stored.reasoningLevel } : {}),
    ...(stored.actor ? { actor: stored.actor } : {}),
    ...(stored.resumedFromSliceId !== undefined
      ? { resumedFromSliceId: stored.resumedFromSliceId }
      : {}),
    ...(stored.surface ? { surface: stored.surface } : {}),
    ...(stored.traceId ? { traceId: stored.traceId } : {}),
    ...(turnStartMessageIndex !== undefined ? { turnStartMessageIndex } : {}),
  };
}

function restoreRuntimeContext(
  projection: ConversationMessageProjection,
  runtimeContext: PiMessage[] | undefined,
): ConversationMessageProjection {
  if (!runtimeContext || runtimeContext.length === 0) return projection;
  const restoredMessages = [...projection.messages];
  const restoredProvenance = [...projection.provenance];
  const unmatchedRuntimeContext: PiMessage[] = [];
  for (const runtimeMessage of runtimeContext) {
    const runtime = runtimeMessage as {
      timestamp?: unknown;
      content?: unknown;
    };
    const targetIndex = restoredMessages.findIndex((message) => {
      const candidate = message as { role?: unknown; timestamp?: unknown };
      return (
        candidate.role === "user" && candidate.timestamp === runtime.timestamp
      );
    });
    if (targetIndex < 0) {
      if (isAgentsInstructionsMessage(runtimeMessage)) {
        const followingIndex = restoredMessages.findIndex((message) => {
          const timestamp = (message as { timestamp?: unknown }).timestamp;
          return (
            typeof runtime.timestamp === "number" &&
            typeof timestamp === "number" &&
            timestamp > runtime.timestamp
          );
        });
        const insertionIndex =
          followingIndex < 0 ? restoredMessages.length : followingIndex;
        restoredMessages.splice(insertionIndex, 0, runtimeMessage);
        restoredProvenance.splice(insertionIndex, 0, contextProvenance);
      } else {
        unmatchedRuntimeContext.push(runtimeMessage);
      }
      continue;
    }
    restoredMessages.splice(targetIndex, 0, runtimeMessage);
    restoredProvenance.splice(targetIndex, 0, contextProvenance);
  }
  return {
    messages: [...unmatchedRuntimeContext, ...restoredMessages],
    provenance: [
      ...unmatchedRuntimeContext.map(() => contextProvenance),
      ...restoredProvenance,
    ],
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
  return value == null ? undefined : parseAgentTurnSessionRecord(value);
}

/** Read a materialized turn session record for resume and history loading. */
async function materializeStoredAgentTurnSessionRecord(
  conversationId: string,
  sessionId: string,
  followCurrentReplacement: boolean,
): Promise<AgentTurnSessionRecord | undefined> {
  const parsed = await getStoredAgentTurnSessionRecord(
    conversationId,
    sessionId,
  );
  if (!parsed) {
    return undefined;
  }

  const pinnedProjection = await loadTurnProjection({
    conversationId,
    committedSeq: parsed.committedSeq,
    // Unfinished records include the current-epoch tail so parked input
    // appended after the last safe boundary stays model-visible on resume.
    includeTail:
      parsed.state === "running" || parsed.state === "awaiting_resume",
  });
  if (!pinnedProjection) {
    return undefined;
  }
  const currentHistory =
    await getConversationEventStore().loadCurrentHistory(conversationId);
  const currentHistoryVersion =
    currentHistory.at(-1)?.historyVersion ?? parsed.historyVersion ?? 0;
  const followsReplacement =
    followCurrentReplacement &&
    (parsed.state === "running" || parsed.state === "awaiting_resume") &&
    parsed.historyVersion !== undefined &&
    parsed.historyVersion !== currentHistoryVersion;
  const piProjection = followsReplacement
    ? projectConversationEvents(currentHistory)
    : pinnedProjection;
  const turnStartMessageIndex = followsReplacement
    ? 0
    : parsed.turnStartSeq === undefined
      ? undefined
      : piProjection.seqs.filter((seq) => seq <= parsed.turnStartSeq!).length;

  return materializeAgentTurnSessionRecord(
    parsed,
    piProjection,
    turnStartMessageIndex,
    !followsReplacement &&
      (parsed.historyVersion === undefined ||
        parsed.historyVersion === currentHistoryVersion),
  );
}

/** Read a turn record pinned to the history version containing its checkpoint. */
export async function getAgentTurnSessionRecord(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionRecord | undefined> {
  return await materializeStoredAgentTurnSessionRecord(
    conversationId,
    sessionId,
    false,
  );
}

/** Read a turn session for resume, following a newer committed replacement while unfinished. */
export async function getAgentTurnSessionRecordForResume(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionRecord | undefined> {
  return await materializeStoredAgentTurnSessionRecord(
    conversationId,
    sessionId,
    true,
  );
}

/** Build the storage record that advances optimistic resume versioning. */
function buildStoredRecord(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  source?: Source;
  committedSeq: number;
  historyVersion?: number;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  modelId?: string;
  previousVersion?: number;
  reasoningLevel?: string;
  actor?: Actor;
  actors?: Actor[];
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  turnStartSeq?: number;
  runtimeContext?: PiMessage[];
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
    committedSeq: args.committedSeq,
    ...(args.historyVersion !== undefined
      ? { historyVersion: args.historyVersion }
      : {}),
    ...(args.turnStartSeq !== undefined
      ? { turnStartSeq: args.turnStartSeq }
      : {}),
    ...(args.runtimeContext && args.runtimeContext.length > 0
      ? { runtimeContext: args.runtimeContext }
      : {}),
    cumulativeDurationMs: args.cumulativeDurationMs,
    ...(args.cumulativeUsage ? { cumulativeUsage: args.cumulativeUsage } : {}),
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    ...(args.dispatchOutcome ? { dispatchOutcome: args.dispatchOutcome } : {}),
    ...(args.resultMessageId ? { resultMessageId: args.resultMessageId } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.actor ? { actor: args.actor } : {}),
    ...(args.actors ? { actors: args.actors } : {}),
    ...(args.loadedSkillNames
      ? { loadedSkillNames: args.loadedSkillNames }
      : {}),
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
    ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(args.resumedFromSliceId !== undefined
      ? { resumedFromSliceId: args.resumedFromSliceId }
      : {}),
    ...(args.surface ? { surface: args.surface } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  };
}

async function setStoredRecord(args: {
  conversationStore?: ConversationStore;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  piMessages: PiMessage[];
  piMessageProvenance: ConversationMessageProvenance[];
  record: StoredAgentTurnSessionRecord;
  ttlMs: number;
  turnStartMessageIndex?: number;
}): Promise<AgentTurnSessionRecord> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  await recordConversationActivityMetadata({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    nowMs: Date.now(),
    summary: args.record,
  });
  await stateAdapter.set(
    agentTurnSessionKey(args.record.conversationId, args.record.sessionId),
    args.record,
    args.ttlMs,
  );
  const {
    actors: _actors,
    committedSeq: _committedSeq,
    historyVersion: _historyVersion,
    errorMessage: _errorMessage,
    turnStartSeq: _turnStartSeq,
    runtimeContext: _runtimeContext,
    ...summary
  } = args.record;
  await appendAgentTurnSessionSummary(summary, args.ttlMs);
  return materializeAgentTurnSessionRecord(
    args.record,
    {
      messages: [...args.piMessages],
      provenance: [...args.piMessageProvenance],
    },
    args.turnStartMessageIndex,
  );
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
    ...(args.existing.turnStartMessageIndex !== undefined
      ? { turnStartMessageIndex: args.existing.turnStartMessageIndex }
      : {}),
    record: buildStoredRecord({
      conversationId: args.existing.conversationId,
      sessionId: args.existing.sessionId,
      sliceId: args.existing.sliceId,
      state: args.state,
      committedSeq: parsed.committedSeq,
      ...(parsed.historyVersion !== undefined
        ? { historyVersion: parsed.historyVersion }
        : {}),
      ...(parsed.turnStartSeq !== undefined
        ? { turnStartSeq: parsed.turnStartSeq }
        : {}),
      ...(parsed.runtimeContext
        ? { runtimeContext: parsed.runtimeContext }
        : {}),
      ...(parsed.channelName ? { channelName: parsed.channelName } : {}),
      startedAtMs: parsed.startedAtMs,
      lastProgressAtMs: parsed.lastProgressAtMs,
      previousVersion: parsed.version,
      cumulativeDurationMs: args.existing.cumulativeDurationMs,
      ...(args.existing.cumulativeUsage
        ? { cumulativeUsage: args.existing.cumulativeUsage }
        : {}),
      ...(args.existing.destination
        ? { destination: args.existing.destination }
        : {}),
      ...(args.existing.dispatchId
        ? { dispatchId: args.existing.dispatchId }
        : {}),
      ...(args.existing.dispatchOutcome
        ? { dispatchOutcome: args.existing.dispatchOutcome }
        : {}),
      ...(args.existing.resultMessageId
        ? { resultMessageId: args.existing.resultMessageId }
        : {}),
      ...(args.existing.source ? { source: args.existing.source } : {}),
      ...(args.existing.loadedSkillNames
        ? { loadedSkillNames: args.existing.loadedSkillNames }
        : {}),
      ...(args.existing.modelId ? { modelId: args.existing.modelId } : {}),
      ...(args.existing.reasoningLevel
        ? { reasoningLevel: args.existing.reasoningLevel }
        : {}),
      ...(args.existing.actor ? { actor: args.existing.actor } : {}),
      actors: args.existing.actors,
      ...(args.existing.resumeReason
        ? { resumeReason: args.existing.resumeReason }
        : {}),
      ...(args.existing.resumedFromSliceId !== undefined
        ? { resumedFromSliceId: args.existing.resumedFromSliceId }
        : {}),
      ...(args.existing.surface ? { surface: args.existing.surface } : {}),
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
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  modelId: string;
  conversationStore?: ConversationStore;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  piMessages: PiMessage[];
  /** Provenance for trailing newly committed messages, such as steering. */
  trailingMessageProvenance?: ConversationMessageProvenance[];
  actor?: Actor;
  actors?: Actor[];
  resumeReason?: AgentTurnResumeReason;
  reasoningLevel?: string;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  turnContexts?: PluginTurnContext[];
  turnStartMessageIndex?: number;
  ttlMs?: number;
}): Promise<AgentTurnSessionRecord> {
  const existingRecord = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  const existingDispatchId =
    existingRecord?.dispatchId ??
    (
      await listAgentTurnSessionSummariesForConversation(args.conversationId)
    ).find((summary) => summary.sessionId === args.sessionId)?.dispatchId;
  if (
    existingDispatchId &&
    args.dispatchId &&
    existingDispatchId !== args.dispatchId
  ) {
    throw new Error(
      `Turn session ${args.sessionId} dispatchId cannot be changed`,
    );
  }
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  // Attribute new user input to the turn's actor as an instruction; the event
  // store reuses committed provenance for the unchanged prefix and defaults the
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
    ...(args.turnContexts && args.turnContexts.length > 0
      ? {
          turnContext: {
            contexts: args.turnContexts,
            turnId: args.sessionId,
          },
        }
      : {}),
  });
  const durableTurnStartMessageIndex =
    args.turnStartMessageIndex === undefined
      ? undefined
      : stripRuntimeTurnContext(
          args.piMessages.slice(0, args.turnStartMessageIndex),
        ).length;
  const runtimeContext = retainRuntimeTurnContext(args.piMessages);
  const retainedRuntimeContext =
    runtimeContext.length > 0
      ? runtimeContext
      : existingRecord?.historyVersion === commit.historyVersion
        ? existingRecord.runtimeContext
        : undefined;
  // Flip the caller's message-index cursor into a durable seq reference: the
  // seq of the last committed message before the turn's fresh prompt.
  const turnStartSeq =
    durableTurnStartMessageIndex === undefined
      ? existingRecord?.turnStartSeq
      : durableTurnStartMessageIndex <= 0
        ? -1
        : (commit.messageSeqs[durableTurnStartMessageIndex - 1] ??
          commit.committedSeq);
  const turnStartMessageIndex =
    durableTurnStartMessageIndex ??
    (turnStartSeq === undefined
      ? undefined
      : commit.messageSeqs.filter((seq) => seq <= turnStartSeq).length);

  return await setStoredRecord({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    piMessages: commit.messages,
    piMessageProvenance: commit.provenance,
    ttlMs,
    ...(turnStartMessageIndex !== undefined ? { turnStartMessageIndex } : {}),
    record: buildStoredRecord({
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
      committedSeq: commit.committedSeq,
      historyVersion: commit.historyVersion,
      ...(turnStartSeq !== undefined ? { turnStartSeq } : {}),
      ...(retainedRuntimeContext
        ? { runtimeContext: retainedRuntimeContext }
        : {}),
      previousVersion: existingRecord?.version,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? existingRecord?.cumulativeDurationMs ?? 0,
      ...(args.cumulativeUsage
        ? { cumulativeUsage: args.cumulativeUsage }
        : {}),
      ...((args.destination ?? existingRecord?.destination)
        ? { destination: args.destination ?? existingRecord?.destination }
        : {}),
      ...((args.dispatchId ?? existingRecord?.dispatchId)
        ? { dispatchId: args.dispatchId ?? existingRecord?.dispatchId }
        : {}),
      ...((args.dispatchOutcome ?? existingRecord?.dispatchOutcome)
        ? {
            dispatchOutcome:
              args.dispatchOutcome ?? existingRecord?.dispatchOutcome,
          }
        : {}),
      ...((args.resultMessageId ?? existingRecord?.resultMessageId)
        ? {
            resultMessageId:
              args.resultMessageId ?? existingRecord?.resultMessageId,
          }
        : {}),
      ...((args.source ?? existingRecord?.source)
        ? { source: args.source ?? existingRecord?.source }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      modelId: args.modelId,
      ...((args.reasoningLevel ?? existingRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? existingRecord?.reasoningLevel,
          }
        : {}),
      ...((args.actor ?? existingRecord?.actor)
        ? { actor: args.actor ?? existingRecord?.actor }
        : {}),
      actors: instructionActors([
        ...(existingRecord?.actors ?? []).map(instructionProvenanceFor),
        ...(args.actors ?? []).map(instructionProvenanceFor),
        ...commit.provenance,
      ]),
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
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  modelId?: string;
  conversationStore?: ConversationStore;
  actor?: Actor;
  resumeReason?: AgentTurnResumeReason;
  reasoningLevel?: string;
  sessionId: string;
  sliceId: number;
  startedAtMs?: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  traceId?: string;
  ttlMs?: number;
}): Promise<void> {
  const stored = await getStoredAgentTurnSessionRecord(
    args.conversationId,
    args.sessionId,
  );
  const priorSummary = (
    await listAgentTurnSessionSummariesForConversation(args.conversationId)
  ).find((summary) => summary.sessionId === args.sessionId);
  const existing = stored ?? priorSummary;
  const existingDispatchId = existing?.dispatchId;
  const existingDispatchOutcome =
    priorSummary?.dispatchOutcome ?? stored?.dispatchOutcome;
  const existingResultMessageId =
    priorSummary?.resultMessageId ?? stored?.resultMessageId;
  if (
    existingDispatchId &&
    args.dispatchId &&
    existingDispatchId !== args.dispatchId
  ) {
    throw new Error(
      `Turn session ${args.sessionId} dispatchId cannot be changed`,
    );
  }
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
      args.cumulativeDurationMs ?? existing?.cumulativeDurationMs ?? 0,
    ...((args.cumulativeUsage ?? existing?.cumulativeUsage)
      ? { cumulativeUsage: args.cumulativeUsage ?? existing?.cumulativeUsage }
      : {}),
    ...((args.destination ?? existing?.destination)
      ? { destination: args.destination ?? existing?.destination }
      : {}),
    ...((args.dispatchId ?? existingDispatchId)
      ? { dispatchId: args.dispatchId ?? existingDispatchId }
      : {}),
    ...((args.dispatchOutcome ?? existingDispatchOutcome)
      ? { dispatchOutcome: args.dispatchOutcome ?? existingDispatchOutcome }
      : {}),
    ...((args.resultMessageId ?? existingResultMessageId)
      ? { resultMessageId: args.resultMessageId ?? existingResultMessageId }
      : {}),
    ...((args.source ?? existing?.source)
      ? { source: args.source ?? existing?.source }
      : {}),
    ...((args.actor ?? existing?.actor)
      ? { actor: args.actor ?? existing?.actor }
      : {}),
    ...(args.loadedSkillNames
      ? { loadedSkillNames: args.loadedSkillNames }
      : existing?.loadedSkillNames
        ? { loadedSkillNames: existing.loadedSkillNames }
        : {}),
    ...((args.modelId ?? existing?.modelId)
      ? { modelId: args.modelId ?? existing?.modelId }
      : {}),
    ...((args.reasoningLevel ?? existing?.reasoningLevel)
      ? { reasoningLevel: args.reasoningLevel ?? existing?.reasoningLevel }
      : {}),
    ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
    ...((args.surface ?? existing?.surface)
      ? { surface: args.surface ?? existing?.surface }
      : {}),
    ...((args.traceId ?? existing?.traceId)
      ? { traceId: args.traceId ?? existing?.traceId }
      : {}),
  };
  await recordConversationActivityMetadata({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    nowMs,
    summary,
  });
  await appendAgentTurnSessionSummary(summary, ttlMs);
}

async function readAgentTurnSessionSummariesFromIndex(
  key: string,
  stateAdapter: StateAdapter,
): Promise<AgentTurnSessionSummary[]> {
  await stateAdapter.connect();
  const values = await stateAdapter.getList(key);
  const summaries = new Map<string, AgentTurnSessionSummary>();

  for (const value of [...values].reverse()) {
    let summary: AgentTurnSessionSummary;
    try {
      summary = parseAgentTurnSessionSummary(value);
    } catch (error) {
      logWarn("agent.turn.session_summary_parse.failed", {
        "app.state.key": key,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const summaryKey = `${summary.conversationId}:${summary.sessionId}`;
    if (!summaries.has(summaryKey)) {
      summaries.set(summaryKey, summary);
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
    await readAgentTurnSessionSummariesFromIndex(
      AGENT_TURN_SESSION_INDEX_KEY,
      getStateAdapter(),
    )
  ).slice(0, Math.max(0, Math.floor(limit)));
}

/** List turn-session summaries for one conversation without the global feed cap. */
export async function listAgentTurnSessionSummariesForConversation(
  conversationId: string,
): Promise<AgentTurnSessionSummary[]> {
  const stateAdapter = getStateAdapter();
  const summaries =
    await listBoundedAgentTurnSessionSummariesForConversation(conversationId);
  if (summaries.length > 0) {
    return summaries;
  }

  return (
    await readAgentTurnSessionSummariesFromIndex(
      AGENT_TURN_SESSION_INDEX_KEY,
      stateAdapter,
    )
  ).filter((summary) => summary.conversationId === conversationId);
}

/** List retained run summaries without falling back to global history. */
export async function listBoundedAgentTurnSessionSummariesForConversation(
  conversationId: string,
): Promise<AgentTurnSessionSummary[]> {
  return readAgentTurnSessionSummariesFromIndex(
    agentTurnSessionConversationIndexKey(conversationId),
    getStateAdapter(),
  );
}

/** Read complete per-conversation summary indexes with bounded backend load. */
export async function listAgentTurnSessionSummariesForConversations(
  stateAdapter: StateAdapter,
  conversationIds: string[],
): Promise<Map<string, AgentTurnSessionSummary[]>> {
  const ids = [...new Set(conversationIds)];
  const globalSummaries = await readAgentTurnSessionSummariesFromIndex(
    AGENT_TURN_SESSION_INDEX_KEY,
    stateAdapter,
  );
  const globalByConversation = new Map<string, AgentTurnSessionSummary[]>();
  for (const summary of globalSummaries) {
    globalByConversation.set(summary.conversationId, [
      ...(globalByConversation.get(summary.conversationId) ?? []),
      summary,
    ]);
  }

  const summariesByConversation = new Map<string, AgentTurnSessionSummary[]>();
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    while (nextIndex < ids.length) {
      const conversationId = ids[nextIndex];
      nextIndex += 1;
      if (!conversationId) continue;
      const summaries = await readAgentTurnSessionSummariesFromIndex(
        agentTurnSessionConversationIndexKey(conversationId),
        stateAdapter,
      );
      summariesByConversation.set(
        conversationId,
        summaries.length > 0
          ? summaries
          : (globalByConversation.get(conversationId) ?? []),
      );
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(AGENT_TURN_SESSION_INDEX_READ_CONCURRENCY, ids.length),
      },
      readNext,
    ),
  );
  return summariesByConversation;
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
