/**
 * Turn session records.
 *
 * These records track one user request across auth pauses, timeout slices, and
 * completion. Full Pi messages live in the durable conversation event store; this
 * record stores resumability metadata and a committed `seq` cursor into
 * `junior_conversation_events` so resumes can materialize the exact continuable
 * boundary without duplicating the event history.
 */
import {
  actorSchema,
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
  agentTurnSessionConversationIndexKey,
  agentTurnSessionKey,
} from "./turn-session-keys";

const AGENT_TURN_SESSION_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
const AGENT_TURN_SESSION_TERMINAL_TTL_MS = 60 * 60 * 1000;

/** Keep only keys whose value is defined. */
function definedProps<T extends Record<string, unknown>>(
  values: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

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
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
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
   * replaces the singular execution actor, which is rebuilt at resume.
   */
  actors: Actor[];
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

export interface AgentTurnSessionSummary {
  conversationId: string;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
  resumeReason?: AgentTurnResumeReason;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  surface?: AgentTurnSurface;
  updatedAtMs: number;
  version: number;
}

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

/** Thin recovery projection stored per conversation. Reporting reads SQL. */
const agentTurnSessionSummarySchema = z
  .object({
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    dispatchId: z.string().min(1).optional(),
    dispatchOutcome: z.enum(["blocked", "completed", "failed"]).optional(),
    resultMessageId: z.string().min(1).optional(),
    resumeReason: agentTurnResumeReasonSchema.optional(),
    sessionId: z.string().min(1),
    sliceId: z.number().int().nonnegative(),
    state: agentTurnSessionStatusSchema,
    surface: agentTurnSurfaceSchema.optional(),
    updatedAtMs: nonNegativeNumberSchema,
  })
  .strip() satisfies z.ZodType<AgentTurnSessionSummary>;

/** Full turn-session record stored under the session key. */
const storedAgentTurnSessionRecordSchema = z
  .object({
    channelName: z.string().min(1).optional(),
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    cumulativeDurationMs: nonNegativeNumberSchema,
    cumulativeUsage: agentTurnUsageSchema.optional(),
    dispatchId: z.string().min(1).optional(),
    dispatchOutcome: z.enum(["blocked", "completed", "failed"]).optional(),
    resultMessageId: z.string().min(1).optional(),
    lastProgressAtMs: nonNegativeNumberSchema,
    loadedSkillNames: z.array(z.string()).optional(),
    modelId: z.string().min(1).optional(),
    reasoningLevel: z.string().min(1).optional(),
    resumeReason: agentTurnResumeReasonSchema.optional(),
    resumedFromSliceId: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1),
    sliceId: z.number().int().nonnegative(),
    startedAtMs: nonNegativeNumberSchema,
    state: agentTurnSessionStatusSchema,
    surface: agentTurnSurfaceSchema.optional(),
    traceId: z.string().optional(),
    updatedAtMs: nonNegativeNumberSchema,
    actors: z.array(actorSchema).optional(),
    committedSeq: seqCursorSchema,
    historyVersion: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    turnStartSeq: seqCursorSchema.optional(),
    runtimeContext: z.array(piMessageSchema).optional(),
  })
  .strip() satisfies z.ZodType<StoredAgentTurnSessionRecord>;

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

function agentTurnSessionRecordTtlMs(
  state: AgentTurnSessionStatus,
  ttlMs?: number,
): number {
  if (ttlMs !== undefined) {
    return Math.max(1, ttlMs);
  }
  return state === "running" || state === "awaiting_resume"
    ? AGENT_TURN_SESSION_RESUME_TTL_MS
    : AGENT_TURN_SESSION_TERMINAL_TTL_MS;
}

/**
 * The per-conversation recovery index holds many sessions. Keep it on the resume
 * window so a terminal write cannot expire unfinished siblings still under a
 * resume lease. Explicit ttl overrides (tests) still win.
 */
function agentTurnSessionIndexTtlMs(ttlMs?: number): number {
  return Math.max(1, ttlMs ?? AGENT_TURN_SESSION_RESUME_TTL_MS);
}

function projectAgentTurnSessionSummary(
  record: StoredAgentTurnSessionRecord,
): AgentTurnSessionSummary {
  return agentTurnSessionSummarySchema.parse(record);
}

async function appendAgentTurnSessionSummary(
  summary: AgentTurnSessionSummary,
  ttlMs: number,
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.appendToList(
    agentTurnSessionConversationIndexKey(summary.conversationId),
    agentTurnSessionSummarySchema.parse(summary),
    { ttlMs },
  );
}

/** Store run summary metadata in the configured conversation store. */
async function recordConversationActivityMetadata(args: {
  /** Live execution actor for SQL dual-write only; never stored in Redis. */
  actor?: Actor;
  conversationStore?: ConversationStore;
  destination?: Destination;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  nowMs: number;
  /**
   * Structured inbound Source for SQL conversation metadata.
   * Named `source` here to match the turn-session write API; mapped to the
   * conversation store's `sessionSource` field below because that store also
   * has a separate coarse `source` enum (slack/api/scheduler/...).
   */
  source?: Source;
  summary: AgentTurnSessionSummary & {
    channelName?: string;
    cumulativeDurationMs: number;
    cumulativeUsage?: AgentTurnUsage;
    startedAtMs: number;
  };
}): Promise<void> {
  const conversationStore = args.conversationStore ?? getConversationStore();
  const conversation = await conversationStore.get({
    conversationId: args.summary.conversationId,
  });
  const isChild = Boolean(conversation?.lineage);
  // Nested destination/source/actor stay off Redis turn-session payloads; callers
  // pass live routing/identity here for SQL dual-write. Child conversations stay
  // destinationless.
  const destination = isChild ? undefined : args.destination;
  // Only derive ConversationSource when routing is known. Abandon/fail no longer
  // carry nested destination, and SQL coalesce(excluded, existing) would otherwise
  // overwrite a durable `local` source with surface `internal`.
  const activitySource = isChild
    ? "internal"
    : destination?.platform === "local"
      ? "local"
      : destination
        ? args.summary.surface
        : undefined;
  await conversationStore.recordActivity({
    activityAtMs: args.summary.updatedAtMs,
    channelName: args.summary.channelName,
    conversationId: args.summary.conversationId,
    destination,
    nowMs: args.nowMs,
    actor: sessionLogActor(args.actor),
    ...definedProps({ source: activitySource }),
    ...(args.source ? { sessionSource: args.source } : {}),
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
    actor: sessionLogActor(args.actor),
    ...definedProps({ source: activitySource }),
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
    ...definedProps({
      channelName: stored.channelName,
      cumulativeUsage: stored.cumulativeUsage,
      dispatchId: stored.dispatchId,
      dispatchOutcome: stored.dispatchOutcome,
      errorMessage: stored.errorMessage,
      loadedSkillNames: stored.loadedSkillNames,
      modelId: stored.modelId,
      reasoningLevel: stored.reasoningLevel,
      resumeReason: stored.resumeReason,
      resultMessageId: stored.resultMessageId,
      resumedFromSliceId: stored.resumedFromSliceId,
      surface: stored.surface,
      traceId: stored.traceId,
      turnStartMessageIndex,
    }),
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
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  committedSeq: number;
  historyVersion?: number;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  modelId?: string;
  previousVersion?: number;
  reasoningLevel?: string;
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
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    startedAtMs: args.startedAtMs ?? nowMs,
    lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
    updatedAtMs: nowMs,
    committedSeq: args.committedSeq,
    cumulativeDurationMs: args.cumulativeDurationMs,
    ...definedProps({
      actors: args.actors,
      channelName: args.channelName,
      cumulativeUsage: args.cumulativeUsage,
      dispatchId: args.dispatchId,
      dispatchOutcome: args.dispatchOutcome,
      errorMessage: args.errorMessage,
      historyVersion: args.historyVersion,
      loadedSkillNames: args.loadedSkillNames,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      resumeReason: args.resumeReason,
      resultMessageId: args.resultMessageId,
      resumedFromSliceId: args.resumedFromSliceId,
      runtimeContext:
        args.runtimeContext && args.runtimeContext.length > 0
          ? args.runtimeContext
          : undefined,
      surface: args.surface,
      traceId: args.traceId,
      turnStartSeq: args.turnStartSeq,
    }),
  };
}

async function setStoredRecord(args: {
  actor?: Actor;
  conversationStore?: ConversationStore;
  destination?: Destination;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  piMessages: PiMessage[];
  piMessageProvenance: ConversationMessageProvenance[];
  record: StoredAgentTurnSessionRecord;
  source?: Source;
  /** Per-record TTL (state-split). */
  ttlMs: number;
  /** Recovery index TTL override; defaults to the resume window. */
  indexTtlMs?: number;
  turnStartMessageIndex?: number;
}): Promise<AgentTurnSessionRecord> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const storedRecord = storedAgentTurnSessionRecordSchema.parse(args.record);
  await recordConversationActivityMetadata({
    actor: args.actor,
    conversationStore: args.conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    nowMs: Date.now(),
    source: args.source,
    summary: storedRecord,
  });
  await stateAdapter.set(
    agentTurnSessionKey(storedRecord.conversationId, storedRecord.sessionId),
    storedRecord,
    args.ttlMs,
  );
  // The per-conversation recovery index is multi-session; keep the resume
  // window so a terminal write cannot expire unfinished siblings.
  await appendAgentTurnSessionSummary(
    projectAgentTurnSessionSummary(storedRecord),
    agentTurnSessionIndexTtlMs(args.indexTtlMs),
  );
  return materializeAgentTurnSessionRecord(
    storedRecord,
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
    ttlMs: agentTurnSessionRecordTtlMs(args.state),
    ...definedProps({
      turnStartMessageIndex: args.existing.turnStartMessageIndex,
    }),
    record: buildStoredRecord({
      conversationId: args.existing.conversationId,
      sessionId: args.existing.sessionId,
      sliceId: args.existing.sliceId,
      state: args.state,
      committedSeq: parsed.committedSeq,
      startedAtMs: parsed.startedAtMs,
      lastProgressAtMs: parsed.lastProgressAtMs,
      previousVersion: parsed.version,
      cumulativeDurationMs: args.existing.cumulativeDurationMs,
      actors: args.existing.actors,
      ...definedProps({
        channelName: parsed.channelName,
        cumulativeUsage: args.existing.cumulativeUsage,
        dispatchId: args.existing.dispatchId,
        dispatchOutcome: args.existing.dispatchOutcome,
        errorMessage: args.errorMessage ?? args.existing.errorMessage,
        historyVersion: parsed.historyVersion,
        loadedSkillNames: args.existing.loadedSkillNames,
        modelId: args.existing.modelId,
        reasoningLevel: args.existing.reasoningLevel,
        resumeReason: args.existing.resumeReason,
        resultMessageId: args.existing.resultMessageId,
        resumedFromSliceId: args.existing.resumedFromSliceId,
        surface: args.existing.surface,
        traceId: args.existing.traceId,
        turnStartSeq: parsed.turnStartSeq,
      }),
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
  const ttlMs = agentTurnSessionRecordTtlMs(args.state, args.ttlMs);
  // Attribute new user input to the turn's actor as an instruction; the event
  // store reuses committed provenance for the unchanged prefix and defaults the
  // rest to context. Platform-neutral so local identities are preserved too.
  // Execution actor is not stored in Redis — callers pass it live for SQL
  // dual-write and fresh instruction attribution only.
  const instructionActor = args.actor;
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
    actor: args.actor,
    conversationStore: args.conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    source: args.source,
    piMessages: commit.messages,
    piMessageProvenance: commit.provenance,
    ttlMs,
    // Pass through only an explicit override so indexes stay on the resume window
    // by default even when the record takes a short terminal TTL.
    ...definedProps({ indexTtlMs: args.ttlMs }),
    turnStartMessageIndex,
    record: buildStoredRecord({
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: args.state,
      committedSeq: commit.committedSeq,
      historyVersion: commit.historyVersion,
      previousVersion: existingRecord?.version,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? existingRecord?.cumulativeDurationMs ?? 0,
      modelId: args.modelId,
      actors: instructionActors([
        ...(existingRecord?.actors ?? []).map(instructionProvenanceFor),
        ...(args.actors ?? []).map(instructionProvenanceFor),
        ...commit.provenance,
      ]),
      ...definedProps({
        channelName: args.channelName ?? existingRecord?.channelName,
        cumulativeUsage: args.cumulativeUsage,
        dispatchId: args.dispatchId ?? existingRecord?.dispatchId,
        dispatchOutcome:
          args.dispatchOutcome ?? existingRecord?.dispatchOutcome,
        errorMessage: args.errorMessage,
        lastProgressAtMs: args.lastProgressAtMs,
        loadedSkillNames: args.loadedSkillNames,
        reasoningLevel: args.reasoningLevel ?? existingRecord?.reasoningLevel,
        resumeReason: args.resumeReason,
        resultMessageId:
          args.resultMessageId ?? existingRecord?.resultMessageId,
        resumedFromSliceId: args.resumedFromSliceId,
        runtimeContext:
          args.state === "running" || args.state === "awaiting_resume"
            ? retainedRuntimeContext
            : undefined,
        startedAtMs: existingRecord?.startedAtMs,
        surface: args.surface ?? existingRecord?.surface,
        traceId: args.traceId ?? existingRecord?.traceId,
        turnStartSeq,
      }),
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
  // Summary-only path writes the recovery index, not the per-session record key.
  const ttlMs = agentTurnSessionIndexTtlMs(args.ttlMs);
  const summary: AgentTurnSessionSummary = {
    version: existing?.version ?? 0,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    updatedAtMs: nowMs,
    ...definedProps({
      dispatchId: args.dispatchId ?? existingDispatchId,
      dispatchOutcome: args.dispatchOutcome ?? existingDispatchOutcome,
      resumeReason: args.resumeReason,
      resultMessageId: args.resultMessageId ?? existingResultMessageId,
      surface: args.surface ?? existing?.surface,
    }),
  };
  await recordConversationActivityMetadata({
    actor: args.actor,
    conversationStore: args.conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    nowMs,
    source: args.source,
    summary: {
      ...summary,
      channelName: args.channelName ?? stored?.channelName,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? stored?.cumulativeDurationMs ?? 0,
      cumulativeUsage: args.cumulativeUsage ?? stored?.cumulativeUsage,
      startedAtMs: stored?.startedAtMs ?? args.startedAtMs ?? nowMs,
    },
  });
  await appendAgentTurnSessionSummary(summary, ttlMs);
}

async function readAgentTurnSessionSummariesFromIndex(
  key: string,
): Promise<AgentTurnSessionSummary[]> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const values = await stateAdapter.getList(key);
  const summaries = new Map<string, AgentTurnSessionSummary>();

  for (const value of [...values].reverse()) {
    let summary: AgentTurnSessionSummary;
    try {
      summary = parseAgentTurnSessionSummary(value);
    } catch {
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

/** List retained turn-session recovery projections for one conversation. */
export async function listAgentTurnSessionSummariesForConversation(
  conversationId: string,
): Promise<AgentTurnSessionSummary[]> {
  return readAgentTurnSessionSummariesFromIndex(
    agentTurnSessionConversationIndexKey(conversationId),
  );
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
