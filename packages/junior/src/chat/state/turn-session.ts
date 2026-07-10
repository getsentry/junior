/**
 * Turn session records.
 *
 * These records track one user request across auth pauses, timeout slices, and
 * completion. Full Pi messages live in the durable agent step store; this
 * record stores resumability metadata and a committed `seq` cursor into
 * `junior_agent_steps` so resumes can materialize the exact continuable
 * boundary without duplicating the step history.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import {
  actorSchema,
  destinationSchema,
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { PiMessage } from "@/chat/pi/messages";
import { toStoredSlackActor, type Actor } from "@/chat/actor";
import {
  instructionActors,
  instructionProvenanceFor,
  type PiMessageProvenance,
  type SessionProjection,
} from "./session-log";
import {
  commitMessages,
  loadTurnProjection,
} from "@/chat/conversations/projection";
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";
import { getConversationStore } from "@/chat/db";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type {
  ConversationExecution,
  ConversationStore,
} from "@/chat/conversations/store";

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
  modelId?: string;
  reasoningLevel?: string;
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
  "actors" | "piMessages" | "piMessageProvenance" | "turnStartMessageIndex"
> {
  /**
   * `seq` of the last step in `junior_agent_steps` whose projection reproduces
   * this record's committed Pi messages; -1 when nothing was committed.
   */
  committedSeq: number;
  /**
   * `seq` boundary where this turn's fresh prompt starts: the seq of the last
   * projected message before the prompt, or -1 when the turn starts the epoch.
   */
  turnStartSeq?: number;
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
]) satisfies z.ZodType<AgentTurnResumeReason>;

const nonNegativeNumberSchema = z.number().finite().nonnegative();
const seqCursorSchema = z.number().int().min(-1);
const agentTurnUsageSchema = z
  .object({
    inputTokens: nonNegativeNumberSchema.optional(),
    outputTokens: nonNegativeNumberSchema.optional(),
    cachedInputTokens: nonNegativeNumberSchema.optional(),
    cacheCreationTokens: nonNegativeNumberSchema.optional(),
    totalTokens: nonNegativeNumberSchema.optional(),
  })
  .strict() satisfies z.ZodType<AgentTurnUsage>;

const agentTurnSessionSummarySchema = z
  .object({
    channelName: z.string().min(1).optional(),
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    cumulativeDurationMs: nonNegativeNumberSchema,
    cumulativeUsage: agentTurnUsageSchema.optional(),
    destination: destinationSchema.optional(),
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
    committedSeq: seqCursorSchema,
    errorMessage: z.string().optional(),
    turnStartSeq: seqCursorSchema.optional(),
  })
  .strict() satisfies z.ZodType<StoredAgentTurnSessionRecord>;

function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

function agentTurnSessionConversationIndexKey(conversationId: string): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
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
}

function materializeAgentTurnSessionRecord(
  stored: StoredAgentTurnSessionRecord,
  piProjection: SessionProjection,
  turnStartMessageIndex?: number,
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

  const piProjection = await loadTurnProjection({
    conversationId,
    committedSeq: parsed.committedSeq,
    // Unfinished records include the current-epoch tail so parked input
    // appended after the last safe boundary stays model-visible on resume.
    includeTail:
      parsed.state === "running" || parsed.state === "awaiting_resume",
  });
  if (!piProjection) {
    return undefined;
  }
  const turnStartMessageIndex =
    parsed.turnStartSeq === undefined
      ? undefined
      : piProjection.seqs.filter((seq) => seq <= parsed.turnStartSeq!).length;

  return materializeAgentTurnSessionRecord(
    parsed,
    piProjection,
    turnStartMessageIndex,
  );
}

/** Build the storage record that advances optimistic resume versioning. */
function buildStoredRecord(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  committedSeq: number;
  lastProgressAtMs?: number;
  loadedSkillNames?: string[];
  modelId?: string;
  previousVersion?: number;
  reasoningLevel?: string;
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
  turnStartSeq?: number;
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
    ...(args.turnStartSeq !== undefined
      ? { turnStartSeq: args.turnStartSeq }
      : {}),
    cumulativeDurationMs: args.cumulativeDurationMs,
    ...(args.cumulativeUsage ? { cumulativeUsage: args.cumulativeUsage } : {}),
    ...(args.destination ? { destination: args.destination } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.actor ? { actor: args.actor } : {}),
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
  /** Source-confirmed destination visibility from the current event's signal. */
  destinationVisibility?: ConversationPrivacy;
  piMessages: PiMessage[];
  piMessageProvenance: PiMessageProvenance[];
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
    committedSeq: _committedSeq,
    errorMessage: _errorMessage,
    turnStartSeq: _turnStartSeq,
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
      ...(parsed.turnStartSeq !== undefined
        ? { turnStartSeq: parsed.turnStartSeq }
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
      ...(args.existing.source ? { source: args.existing.source } : {}),
      ...(args.existing.loadedSkillNames
        ? { loadedSkillNames: args.existing.loadedSkillNames }
        : {}),
      ...(args.existing.modelId ? { modelId: args.existing.modelId } : {}),
      ...(args.existing.reasoningLevel
        ? { reasoningLevel: args.existing.reasoningLevel }
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
  modelId?: string;
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
  reasoningLevel?: string;
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
  // Attribute new user input to the turn's actor as an instruction; the step
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
  });
  // Flip the caller's message-index cursor into a durable seq reference: the
  // seq of the last committed message before the turn's fresh prompt.
  const turnStartSeq =
    args.turnStartMessageIndex === undefined
      ? existingRecord?.turnStartSeq
      : args.turnStartMessageIndex <= 0
        ? -1
        : (commit.messageSeqs[args.turnStartMessageIndex - 1] ??
          commit.committedSeq);
  const turnStartMessageIndex =
    args.turnStartMessageIndex ??
    (turnStartSeq === undefined
      ? undefined
      : commit.messageSeqs.filter((seq) => seq <= turnStartSeq).length);

  return await setStoredRecord({
    conversationStore: args.conversationStore,
    destinationVisibility: args.destinationVisibility,
    piMessages: args.piMessages,
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
      ...(turnStartSeq !== undefined ? { turnStartSeq } : {}),
      previousVersion: existingRecord?.version,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? existingRecord?.cumulativeDurationMs ?? 0,
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
      ...((existingRecord?.modelId ?? args.modelId)
        ? { modelId: existingRecord?.modelId ?? args.modelId }
        : {}),
      ...((args.reasoningLevel ?? existingRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? existingRecord?.reasoningLevel,
          }
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
      args.cumulativeDurationMs ?? existing?.cumulativeDurationMs ?? 0,
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
    ...(args.loadedSkillNames
      ? { loadedSkillNames: args.loadedSkillNames }
      : existing?.loadedSkillNames
        ? { loadedSkillNames: existing.loadedSkillNames }
        : {}),
    ...((existing?.modelId ?? args.modelId)
      ? { modelId: existing?.modelId ?? args.modelId }
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
): Promise<AgentTurnSessionSummary[]> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const values = await stateAdapter.getList(key);
  const summaries = new Map<string, AgentTurnSessionSummary>();

  for (const value of [...values].reverse()) {
    const summary = parseAgentTurnSessionSummary(value);
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
