/**
 * Internal turn cursor storage for `checkpoint.ts`.
 *
 * Callers outside `task-execution/` should use `checkpoint.ts` only.
 * These records track one turn across auth pauses, timeout slices, and
 * completion. Full Pi messages live in SQL conversation events; this store
 * keeps resume metadata and a committed `seq` cursor into
 * `junior_conversation_events`.
 */
import {
  actorSchema,
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
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";
import { botConfig } from "@/chat/config";
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
  turnCursorIndexKey,
  turnCursorKey,
  turnCursorMutationKey,
} from "./turn-cursor-keys";

const TURN_CURSOR_SCHEMA_VERSION = 2;
const TURN_CURSOR_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
const TURN_CURSOR_TERMINAL_TTL_MS = 60 * 60 * 1000;
const TURN_CURSOR_MUTATION_LOCK_WAIT_MS = 10_000;

async function withTurnCursorMutation<T>(
  conversationId: string,
  turnId: string,
  run: (fence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  await state.connect();
  const result = await withLock(
    state,
    turnCursorMutationKey(conversationId, turnId),
    async (lock) => await run(async () => await fenceLock(state, lock)),
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: TURN_CURSOR_MUTATION_LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) {
    throw new Error(`Could not acquire turn cursor lock for ${turnId}`);
  }
  return result.value;
}

function executionMetricsForTurn(
  conversation: Awaited<ReturnType<ConversationStore["get"]>>,
  turnId: string,
): { durationMs: number; usage?: AgentTurnUsage } | undefined {
  return conversation?.executionMetrics?.runId === turnId
    ? conversation.executionMetrics
    : undefined;
}

/** Keep only keys whose value is defined. */
function definedProps<T extends Record<string, unknown>>(
  values: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

type TurnStatus = "running" | "paused" | "completed" | "failed" | "abandoned";

export type AgentTurnSurface = "slack" | "api" | "scheduler" | "internal";

export type TurnPauseReason = "timeout" | "auth" | "yield" | "retry";
export type AgentDispatchOutcome = "blocked" | "completed" | "failed";

interface ConversationMessageProjection {
  messages: PiMessage[];
  provenance: ConversationMessageProvenance[];
}

export interface TurnRecord {
  /**
   * Actor that started this Turn; absent only on stored legacy cursors.
   *
   * TODO(dcramer): Make this field required after no deployed Turn cursor can
   * omit Actor.
   */
  actor?: Actor;
  channelName?: string;
  schemaVersion: 2;
  version: number;
  conversationId: string;
  cumulativeDurationMs: number;
  /** Tool calls charged to this turn; survives history replacement. */
  cumulativeToolCallCount?: number;
  cumulativeUsage?: AgentTurnUsage;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
  errorMessage?: string;
  lastProgressAtMs: number;
  piMessages: PiMessage[];
  /** Per-message provenance aligned one-to-one with `piMessages`. */
  piMessageProvenance: ConversationMessageProvenance[];
  /**
   * All distinct actors annotated on this run's committed instruction-authority
   * messages, in first-seen order. Derived from committed provenance so a
   * summary-only handoff cannot erase them. It never grants authority or
   * replaces the singular execution actor, which is rebuilt at resume.
   */
  actors: Actor[];
  resumeReason?: TurnPauseReason;
  /** Input that started this Turn; absent only on stored legacy cursors. */
  source?: Source;
  resumedFromSliceId?: number;
  turnId: string;
  sliceId: number;
  startedAtMs: number;
  state: TurnStatus;
  surface?: AgentTurnSurface;
  traceId?: string;
  turnStartMessageIndex?: number;
  updatedAtMs: number;
}

export interface TurnSummary {
  schemaVersion: 2;
  conversationId: string;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
  resumeReason?: TurnPauseReason;
  turnId: string;
  sliceId: number;
  state: TurnStatus;
  surface?: AgentTurnSurface;
  updatedAtMs: number;
  version: number;
}

interface StoredTurnRecord extends Omit<
  TurnRecord,
  | "actors"
  | "channelName"
  | "cumulativeDurationMs"
  | "cumulativeUsage"
  | "piMessages"
  | "piMessageProvenance"
  | "turnStartMessageIndex"
> {
  /** Redis field kept for deployed workers that still read publishExternally. */
  publishExternally?: boolean;
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
  /** Volatile bootstrap retained only in the resumable turn cursor, never SQL. */
  runtimeContext?: PiMessage[];
}

const turnStatusSchema = z.enum([
  "running",
  "paused",
  "completed",
  "failed",
  "abandoned",
]) satisfies z.ZodType<TurnStatus>;

const turnSurfaceSchema = z.enum([
  "slack",
  "api",
  "scheduler",
  "internal",
]) satisfies z.ZodType<AgentTurnSurface>;

const turnPauseReasonSchema = z.enum([
  "timeout",
  "auth",
  "yield",
  "retry",
]) satisfies z.ZodType<TurnPauseReason>;

const nonNegativeNumberSchema = z.number().finite().nonnegative();
const seqCursorSchema = z.number().int().min(-1);

/** Thin recovery projection stored per conversation. Reporting reads SQL. */
const storedTurnSummarySchema = z
  .object({
    schemaVersion: z.literal(TURN_CURSOR_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    dispatchId: z.string().min(1).optional(),
    dispatchOutcome: z.enum(["blocked", "completed", "failed"]).optional(),
    resultMessageId: z.string().min(1).optional(),
    resumeReason: turnPauseReasonSchema.optional(),
    turnId: z.string().min(1),
    sliceId: z.number().int().nonnegative(),
    state: turnStatusSchema,
    surface: turnSurfaceSchema.optional(),
    updatedAtMs: nonNegativeNumberSchema,
  })
  .strip() satisfies z.ZodType<TurnSummary>;

/** Full resume cursor stored for one turn. */
const storedTurnRecordSchema = z
  .object({
    // TODO(dcramer): Require Actor after no deployed Turn cursor can omit it.
    actor: actorSchema.optional(),
    schemaVersion: z.literal(TURN_CURSOR_SCHEMA_VERSION),
    version: z.number().int().nonnegative(),
    conversationId: z.string().min(1),
    dispatchId: z.string().min(1).optional(),
    dispatchOutcome: z.enum(["blocked", "completed", "failed"]).optional(),
    resultMessageId: z.string().min(1).optional(),
    lastProgressAtMs: nonNegativeNumberSchema,
    resumeReason: turnPauseReasonSchema.optional(),
    publishExternally: z.boolean().optional(),
    source: sourceSchema.optional(),
    resumedFromSliceId: z.number().int().nonnegative().optional(),
    turnId: z.string().min(1),
    sliceId: z.number().int().nonnegative(),
    startedAtMs: nonNegativeNumberSchema,
    state: turnStatusSchema,
    surface: turnSurfaceSchema.optional(),
    traceId: z.string().optional(),
    updatedAtMs: nonNegativeNumberSchema,
    committedSeq: seqCursorSchema,
    historyVersion: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    cumulativeToolCallCount: z.number().int().nonnegative().optional(),
    turnStartSeq: seqCursorSchema.optional(),
    runtimeContext: z.array(piMessageSchema).optional(),
  })
  .strip() satisfies z.ZodType<StoredTurnRecord>;

function conversationExecutionFromSummary(
  summary: TurnSummary,
): ConversationExecution {
  const status =
    summary.state === "completed" || summary.state === "abandoned"
      ? "idle"
      : summary.state;
  return {
    status,
    runId: summary.turnId,
    updatedAtMs: summary.updatedAtMs,
  };
}

function sessionLogActor(
  actor: Actor | undefined,
): ReturnType<typeof toStoredSlackActor> | undefined {
  return actor?.platform === "slack" ? toStoredSlackActor(actor) : undefined;
}

function parseTurnRecord(value: unknown): StoredTurnRecord {
  return storedTurnRecordSchema.parse(value);
}

function parseTurnSummary(value: unknown): TurnSummary {
  return storedTurnSummarySchema.parse(value);
}

function storeTurnSummary(summary: TurnSummary) {
  return storedTurnSummarySchema.parse(summary);
}

function turnCursorTtlMs(state: TurnStatus, ttlMs?: number): number {
  if (ttlMs !== undefined) {
    return Math.max(1, ttlMs);
  }
  return state === "running" || state === "paused"
    ? TURN_CURSOR_RESUME_TTL_MS
    : TURN_CURSOR_TERMINAL_TTL_MS;
}

/**
 * The per-conversation recovery index holds many turns. Keep it on the resume
 * window so a terminal write cannot expire unfinished siblings still under a
 * resume lease. Explicit ttl overrides (tests) still win.
 */
function turnCursorIndexTtlMs(ttlMs?: number): number {
  return Math.max(1, ttlMs ?? TURN_CURSOR_RESUME_TTL_MS);
}

function projectTurnSummary(record: StoredTurnRecord): TurnSummary {
  return parseTurnSummary(record);
}

async function appendTurnSummary(
  summary: TurnSummary,
  ttlMs: number,
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.appendToList(
    turnCursorIndexKey(summary.conversationId),
    storeTurnSummary(summary),
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
   * Named `source` here to match the checkpoint write API; mapped to the
   * conversation store's `sessionSource` field below because that store also
   * has a separate coarse `source` enum (slack/api/scheduler/...).
   */
  source?: Source;
  summary: TurnSummary & {
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
  const hasParent = Boolean(conversation?.parentConversationId);
  // Destination and Actor stay off Redis cursor payloads. Source is stored on
  // the Turn. Callers also pass it here for the SQL Conversation write.
  // Conversations with a parent keep no Destination.
  const destination = hasParent ? undefined : args.destination;
  // Root dual-write requires a destination on first create. Cursor-only writes
  // without destination stay Redis-only until a real root upsert lands.
  if (!hasParent && !destination && !conversation) {
    return;
  }
  // Only derive ConversationSource when routing is known. Abandon/fail no longer
  // carry nested destination, and SQL coalesce(excluded, existing) would otherwise
  // overwrite a durable `local` source with surface `internal`.
  // Prefer the typed session Source branch when present so web/dashboard turns
  // are not collapsed to local just because delivery uses a local destination.
  const activitySource = hasParent
    ? "internal"
    : args.source?.kind === "web"
      ? "web"
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
    ...(args.source ? { sessionSource: args.source } : undefined),
    visibility: hasParent ? undefined : args.destinationVisibility,
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
        : undefined),
    },
    actor: sessionLogActor(args.actor),
    ...definedProps({ source: activitySource }),
    updatedAtMs: args.nowMs,
    visibility: hasParent ? undefined : args.destinationVisibility,
  });
}

/** SQL-backed conversation metrics attached when materializing a turn cursor. */
interface ConversationRuntimeMetrics {
  channelName?: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
}

function materializeTurnRecord(
  stored: StoredTurnRecord,
  piProjection: ConversationMessageProjection,
  turnStartMessageIndex?: number,
  restoreVolatileContext = true,
  runtimeMetrics?: ConversationRuntimeMetrics,
): TurnRecord {
  const restoredProjection =
    restoreVolatileContext &&
    (stored.state === "running" || stored.state === "paused")
      ? restoreRuntimeContext(piProjection, stored.runtimeContext)
      : piProjection;
  return {
    ...definedProps({ actor: stored.actor }),
    schemaVersion: stored.schemaVersion,
    version: stored.version,
    conversationId: stored.conversationId,
    turnId: stored.turnId,
    sliceId: stored.sliceId,
    state: stored.state,
    startedAtMs: stored.startedAtMs,
    lastProgressAtMs: stored.lastProgressAtMs,
    updatedAtMs: stored.updatedAtMs,
    piMessages: restoredProjection.messages,
    piMessageProvenance: restoredProjection.provenance,
    actors: instructionActors(piProjection.provenance),
    cumulativeDurationMs: runtimeMetrics?.cumulativeDurationMs ?? 0,
    ...definedProps({
      channelName: runtimeMetrics?.channelName,
      cumulativeToolCallCount: stored.cumulativeToolCallCount,
      cumulativeUsage: runtimeMetrics?.cumulativeUsage,
      dispatchId: stored.dispatchId,
      dispatchOutcome: stored.dispatchOutcome,
      errorMessage: stored.errorMessage,
      resumeReason: stored.resumeReason,
      source: stored.source,
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
async function getStoredTurnRecord(
  conversationId: string,
  turnId: string,
): Promise<StoredTurnRecord | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const value = await stateAdapter.get(turnCursorKey(conversationId, turnId));
  return value == null ? undefined : parseTurnRecord(value);
}

/** Read a materialized turn cursor for resume and history loading. */
async function materializeStoredTurnRecord(
  conversationId: string,
  turnId: string,
  followCurrentReplacement: boolean,
): Promise<TurnRecord | undefined> {
  const parsed = await getStoredTurnRecord(conversationId, turnId);
  if (!parsed) {
    return undefined;
  }

  const pinnedProjection = await loadTurnProjection({
    conversationId,
    committedSeq: parsed.committedSeq,
    // Unfinished records include the current-epoch tail so parked input
    // appended after the last safe boundary stays model-visible on resume.
    includeTail: parsed.state === "running" || parsed.state === "paused",
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
    (parsed.state === "running" || parsed.state === "paused") &&
    parsed.historyVersion !== undefined &&
    parsed.historyVersion !== currentHistoryVersion;
  const piProjection = followsReplacement
    ? projectConversationEvents(currentHistory, {
        defaultProfile: botConfig.defaultProfile,
      })
    : pinnedProjection;
  const turnStartMessageIndex = followsReplacement
    ? 0
    : parsed.turnStartSeq === undefined
      ? undefined
      : piProjection.seqs.filter((seq) => seq <= parsed.turnStartSeq!).length;

  const conversation = await getConversationStore().get({ conversationId });
  const executionMetrics = executionMetricsForTurn(conversation, turnId);
  return materializeTurnRecord(
    parsed,
    piProjection,
    turnStartMessageIndex,
    !followsReplacement &&
      (parsed.historyVersion === undefined ||
        parsed.historyVersion === currentHistoryVersion),
    {
      channelName: conversation?.channelName,
      cumulativeDurationMs: executionMetrics?.durationMs,
      cumulativeUsage: executionMetrics?.usage,
    },
  );
}

/** Read a turn record pinned to the history version containing its checkpoint. */
export async function getTurnRecord(
  conversationId: string,
  turnId: string,
): Promise<TurnRecord | undefined> {
  return await materializeStoredTurnRecord(conversationId, turnId, false);
}

/** Read a turn cursor for resume, following a newer committed replacement while unfinished. */
export async function getTurnRecordForResume(
  conversationId: string,
  turnId: string,
): Promise<TurnRecord | undefined> {
  return await materializeStoredTurnRecord(conversationId, turnId, true);
}

/** Build the storage record that advances optimistic resume versioning. */
function buildStoredRecord(args: {
  actor?: Actor;
  conversationId: string;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  committedSeq: number;
  historyVersion?: number;
  lastProgressAtMs?: number;
  previousVersion?: number;
  turnId: string;
  sliceId: number;
  startedAtMs?: number;
  state: TurnStatus;
  surface?: AgentTurnSurface;
  resumeReason?: TurnPauseReason;
  publishExternally?: boolean;
  source?: Source;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  cumulativeToolCallCount?: number;
  turnStartSeq?: number;
  runtimeContext?: PiMessage[];
}): StoredTurnRecord {
  const nowMs = Date.now();
  return {
    schemaVersion: TURN_CURSOR_SCHEMA_VERSION,
    version: (args.previousVersion ?? 0) + 1,
    conversationId: args.conversationId,
    turnId: args.turnId,
    sliceId: args.sliceId,
    state: args.state,
    startedAtMs: args.startedAtMs ?? nowMs,
    lastProgressAtMs: args.lastProgressAtMs ?? nowMs,
    updatedAtMs: nowMs,
    committedSeq: args.committedSeq,
    ...definedProps({
      actor: args.actor,
      cumulativeToolCallCount: args.cumulativeToolCallCount,
      dispatchId: args.dispatchId,
      dispatchOutcome: args.dispatchOutcome,
      errorMessage: args.errorMessage,
      historyVersion: args.historyVersion,
      resumeReason: args.resumeReason,
      publishExternally: args.publishExternally,
      source: args.source,
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
  record: StoredTurnRecord;
  /** Channel + execution metrics written beside the Redis resume cursor. */
  runtimeMetrics: {
    channelName?: string;
    cumulativeDurationMs: number;
    cumulativeUsage?: AgentTurnUsage;
  };
  source?: Source;
  /** Per-record TTL (state-split). */
  ttlMs: number;
  /** Recovery index TTL override; defaults to the resume window. */
  indexTtlMs?: number;
  turnStartMessageIndex?: number;
  fence: () => Promise<void>;
}): Promise<TurnRecord> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const storedRecord = storedTurnRecordSchema.parse(args.record);
  await args.fence();
  await recordConversationActivityMetadata({
    actor: args.actor,
    conversationStore: args.conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    nowMs: Date.now(),
    source: args.source,
    summary: {
      ...projectTurnSummary(storedRecord),
      startedAtMs: storedRecord.startedAtMs,
      ...args.runtimeMetrics,
    },
  });
  await args.fence();
  await stateAdapter.set(
    turnCursorKey(storedRecord.conversationId, storedRecord.turnId),
    storedRecord,
    args.ttlMs,
  );
  // The per-conversation recovery index contains many turns; keep the resume
  // window so a terminal write cannot expire unfinished siblings.
  await args.fence();
  await appendTurnSummary(
    projectTurnSummary(storedRecord),
    turnCursorIndexTtlMs(args.indexTtlMs),
  );
  return materializeTurnRecord(
    storedRecord,
    {
      messages: [...args.piMessages],
      provenance: [...args.piMessageProvenance],
    },
    args.turnStartMessageIndex,
    true,
    args.runtimeMetrics,
  );
}

/**
 * Transition an unfinished turn only if the caller still holds the
 * version it loaded, preventing stale resume callbacks from winning.
 */
async function updateTurnState(args: {
  existing: TurnRecord;
  errorMessage?: string;
  fence: () => Promise<void>;
  resultMessageId?: string;
  state: "abandoned" | "completed" | "failed";
}): Promise<TurnRecord | undefined> {
  const parsed = await getStoredTurnRecord(
    args.existing.conversationId,
    args.existing.turnId,
  );
  if (!parsed || parsed.version !== args.existing.version) {
    return undefined;
  }

  return await setStoredRecord({
    actor: args.existing.actor,
    fence: args.fence,
    piMessages: args.existing.piMessages,
    piMessageProvenance: args.existing.piMessageProvenance,
    ttlMs: turnCursorTtlMs(args.state),
    runtimeMetrics: {
      cumulativeDurationMs: args.existing.cumulativeDurationMs,
      ...definedProps({
        channelName: args.existing.channelName,
        cumulativeUsage: args.existing.cumulativeUsage,
      }),
    },
    ...definedProps({
      turnStartMessageIndex: args.existing.turnStartMessageIndex,
    }),
    record: buildStoredRecord({
      actor: args.existing.actor,
      conversationId: args.existing.conversationId,
      turnId: args.existing.turnId,
      sliceId: args.existing.sliceId,
      state: args.state,
      committedSeq: parsed.committedSeq,
      startedAtMs: parsed.startedAtMs,
      lastProgressAtMs: parsed.lastProgressAtMs,
      previousVersion: parsed.version,
      ...definedProps({
        cumulativeToolCallCount: args.existing.cumulativeToolCallCount,
        dispatchId: args.existing.dispatchId,
        dispatchOutcome: args.existing.dispatchOutcome,
        errorMessage: args.errorMessage ?? args.existing.errorMessage,
        historyVersion: parsed.historyVersion,
        resumeReason: args.existing.resumeReason,
        publishExternally: parsed.publishExternally,
        source: args.existing.source,
        resultMessageId: args.resultMessageId ?? args.existing.resultMessageId,
        resumedFromSliceId: args.existing.resumedFromSliceId,
        surface: args.existing.surface,
        traceId: args.existing.traceId,
        turnStartSeq: parsed.turnStartSeq,
      }),
    }),
  });
}

/** Commit stable Pi state and advance the turn cursor. */
export async function upsertTurnRecord(args: {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeToolCallCount?: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  /** Confirmed destination visibility; omit when unavailable. */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  conversationStore?: ConversationStore;
  turnId: string;
  sliceId: number;
  state: TurnStatus;
  surface?: AgentTurnSurface;
  piMessages: PiMessage[];
  /** Provenance for trailing newly committed messages, such as steering. */
  trailingMessageProvenance?: ConversationMessageProvenance[];
  actor?: Actor;
  resumeReason?: TurnPauseReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  traceId?: string;
  turnContexts?: PluginTurnContext[];
  turnStartMessageIndex?: number;
  ttlMs?: number;
}): Promise<TurnRecord> {
  return await withTurnCursorMutation(
    args.conversationId,
    args.turnId,
    async (fence) => await upsertTurnRecordLocked(args, fence),
  );
}

async function upsertTurnRecordLocked(
  args: Parameters<typeof upsertTurnRecord>[0],
  fence: () => Promise<void>,
): Promise<TurnRecord> {
  const existingRecord = await getStoredTurnRecord(
    args.conversationId,
    args.turnId,
  );
  const conversation = await (
    args.conversationStore ?? getConversationStore()
  ).get({
    conversationId: args.conversationId,
  });
  const executionMetrics = executionMetricsForTurn(conversation, args.turnId);
  const existingDispatchId =
    existingRecord?.dispatchId ??
    (await listTurnSummaries(args.conversationId)).find(
      (summary) => summary.turnId === args.turnId,
    )?.dispatchId;
  if (
    existingDispatchId &&
    args.dispatchId &&
    existingDispatchId !== args.dispatchId
  ) {
    throw new Error(`Turn ${args.turnId} dispatchId cannot be changed`);
  }
  const ttlMs = turnCursorTtlMs(args.state, args.ttlMs);
  // Attribute new user input to the turn's actor as an instruction; the event
  // store reuses committed provenance for the unchanged prefix and defaults the
  // rest to context. Platform-neutral so local identities are preserved too.
  // The Turn keeps the starting Actor. New instruction provenance can still
  // record other Actors that steer the same Turn.
  const instructionActor = args.actor;
  const commit = await commitMessages({
    conversationId: args.conversationId,
    messages: args.piMessages,
    ...(instructionActor
      ? { newMessageProvenance: instructionProvenanceFor(instructionActor) }
      : undefined),
    ...(args.trailingMessageProvenance
      ? { trailingMessageProvenance: args.trailingMessageProvenance }
      : undefined),
    ...(args.turnContexts && args.turnContexts.length > 0
      ? {
          turnContext: {
            contexts: args.turnContexts,
            turnId: args.turnId,
          },
        }
      : undefined),
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

  // TODO(dcramer): Remove the stored publishExternally field after no deployed
  // Turn cursor reader requires it. Current workers ignore the field.
  const turnSource = args.source ?? existingRecord?.source;
  const dispatchId = args.dispatchId ?? existingRecord?.dispatchId;
  const hasProviderLocation =
    Boolean(conversation?.location) || args.destination?.platform === "slack";
  const publishExternally =
    dispatchId || turnSource
      ? hasProviderLocation &&
        (Boolean(dispatchId) ||
          turnSource?.kind === "slack" ||
          turnSource?.kind === "resource_event")
      : (existingRecord?.publishExternally ?? false);

  return await setStoredRecord({
    actor: existingRecord?.actor ?? args.actor,
    fence,
    conversationStore: args.conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    source: args.source,
    piMessages: commit.messages,
    piMessageProvenance: commit.provenance,
    ttlMs,
    // Checkpoint commit also updates conversation execution metrics in SQL.
    // Channel/duration/usage are not Redis resume-cursor fields.
    runtimeMetrics: {
      channelName: args.channelName ?? conversation?.channelName,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? executionMetrics?.durationMs ?? 0,
      cumulativeUsage: args.cumulativeUsage ?? executionMetrics?.usage,
    },
    // Pass through only an explicit override so indexes stay on the resume window
    // by default even when the record takes a short terminal TTL.
    ...definedProps({ indexTtlMs: args.ttlMs }),
    turnStartMessageIndex,
    record: buildStoredRecord({
      actor: existingRecord?.actor ?? args.actor,
      conversationId: args.conversationId,
      turnId: args.turnId,
      sliceId: args.sliceId,
      state: args.state,
      committedSeq: commit.committedSeq,
      historyVersion: commit.historyVersion,
      previousVersion: existingRecord?.version,
      ...definedProps({
        cumulativeToolCallCount:
          args.cumulativeToolCallCount ?? existingRecord?.cumulativeToolCallCount,
        dispatchId,
        dispatchOutcome:
          args.dispatchOutcome ?? existingRecord?.dispatchOutcome,
        errorMessage: args.errorMessage,
        lastProgressAtMs: args.lastProgressAtMs,
        resumeReason: args.resumeReason,
        publishExternally,
        source: args.source ?? existingRecord?.source,
        resultMessageId:
          args.resultMessageId ?? existingRecord?.resultMessageId,
        resumedFromSliceId: args.resumedFromSliceId,
        runtimeContext:
          args.state === "running" || args.state === "paused"
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

type TurnSummaryWrite = {
  channelName?: string;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  lastProgressAtMs?: number;
  conversationStore?: ConversationStore;
  actor?: Actor;
  resumeReason?: TurnPauseReason;
  turnId: string;
  sliceId: number;
  startedAtMs?: number;
  state: TurnStatus;
  surface?: AgentTurnSurface;
  traceId?: string;
  ttlMs?: number;
};

/** Record turn metadata without storing conversation messages. */
export async function recordTurnSummary(args: TurnSummaryWrite): Promise<void> {
  await withTurnCursorMutation(
    args.conversationId,
    args.turnId,
    async (fence) => await recordTurnSummaryOwned(args, fence),
  );
}

async function recordTurnSummaryOwned(
  args: TurnSummaryWrite,
  fence: () => Promise<void>,
): Promise<void> {
  const stored = await getStoredTurnRecord(args.conversationId, args.turnId);
  const conversationStore = args.conversationStore ?? getConversationStore();
  const conversation = await conversationStore.get({
    conversationId: args.conversationId,
  });
  const executionMetrics = executionMetricsForTurn(conversation, args.turnId);
  const priorSummary = (await listTurnSummaries(args.conversationId)).find(
    (summary) => summary.turnId === args.turnId,
  );
  const terminalSummary =
    priorSummary &&
    (priorSummary.state === "completed" ||
      priorSummary.state === "failed" ||
      priorSummary.state === "abandoned")
      ? priorSummary
      : undefined;
  const terminalRecord =
    stored &&
    (stored.state === "completed" ||
      stored.state === "failed" ||
      stored.state === "abandoned")
      ? stored
      : undefined;
  const existing = terminalSummary ?? terminalRecord ?? stored ?? priorSummary;
  if (
    (terminalSummary || terminalRecord) &&
    (args.state === "running" || args.state === "paused")
  ) {
    return;
  }
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
    throw new Error(`Turn ${args.turnId} dispatchId cannot be changed`);
  }
  const nowMs = Date.now();
  // Summary-only path writes the recovery index, not the per-turn cursor key.
  const ttlMs = turnCursorIndexTtlMs(args.ttlMs);
  const summary: TurnSummary = {
    schemaVersion: TURN_CURSOR_SCHEMA_VERSION,
    version: existing?.version ?? 0,
    conversationId: args.conversationId,
    turnId: args.turnId,
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
  await fence();
  await recordConversationActivityMetadata({
    actor: args.actor,
    conversationStore,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    nowMs,
    source: args.source,
    summary: {
      ...summary,
      channelName: args.channelName ?? conversation?.channelName,
      cumulativeDurationMs:
        args.cumulativeDurationMs ?? executionMetrics?.durationMs ?? 0,
      cumulativeUsage: args.cumulativeUsage ?? executionMetrics?.usage,
      startedAtMs: stored?.startedAtMs ?? args.startedAtMs ?? nowMs,
    },
  });
  await fence();
  await appendTurnSummary(summary, ttlMs);
}

async function readTurnSummaries(key: string): Promise<TurnSummary[]> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const values = await stateAdapter.getList(key);
  const summaries = new Map<string, TurnSummary>();

  for (const value of [...values].reverse()) {
    let summary: TurnSummary;
    try {
      summary = parseTurnSummary(value);
    } catch {
      continue;
    }
    const summaryKey = `${summary.conversationId}:${summary.turnId}`;
    if (!summaries.has(summaryKey)) {
      summaries.set(summaryKey, summary);
    }
  }

  return [...summaries.values()].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

/** List retained turn recovery projections for one conversation. */
export async function listTurnSummaries(
  conversationId: string,
): Promise<TurnSummary[]> {
  return readTurnSummaries(turnCursorIndexKey(conversationId));
}

/** Mark an unfinished turn cursor as abandoned when a newer turn wins. */
export async function abandonTurnRecord(args: {
  conversationId: string;
  turnId: string;
  errorMessage?: string;
}): Promise<TurnRecord | undefined> {
  return await withTurnCursorMutation(
    args.conversationId,
    args.turnId,
    async (fence) => {
      const existing = await getTurnRecord(args.conversationId, args.turnId);
      if (
        !existing ||
        existing.state === "completed" ||
        existing.state === "failed" ||
        existing.state === "abandoned"
      ) {
        return undefined;
      }

      return await updateTurnState({
        existing,
        fence,
        state: "abandoned",
        errorMessage: args.errorMessage ?? existing.errorMessage,
      });
    },
  );
}

/** Mark an unfinished turn cursor as completed after delivery was accepted. */
export async function completeTurnRecord(args: {
  conversationId: string;
  expectedVersion: number;
  resultMessageId?: string;
  turnId: string;
}): Promise<TurnRecord | undefined> {
  return await withTurnCursorMutation(
    args.conversationId,
    args.turnId,
    async (fence) => {
      const existing = await getTurnRecord(args.conversationId, args.turnId);
      if (
        !existing ||
        existing.state === "completed" ||
        existing.state === "failed" ||
        existing.state === "abandoned" ||
        existing.version !== args.expectedVersion
      ) {
        return undefined;
      }

      return await updateTurnState({
        existing,
        fence,
        resultMessageId: args.resultMessageId,
        state: "completed",
      });
    },
  );
}

/** Mark an unfinished turn cursor as failed so it cannot resume. */
export async function failTurnRecord(args: {
  conversationId: string;
  expectedVersion: number;
  turnId: string;
  errorMessage?: string;
}): Promise<TurnRecord | undefined> {
  return await withTurnCursorMutation(
    args.conversationId,
    args.turnId,
    async (fence) => {
      const existing = await getTurnRecord(args.conversationId, args.turnId);
      if (
        !existing ||
        existing.state === "completed" ||
        existing.state === "failed" ||
        existing.state === "abandoned" ||
        existing.version !== args.expectedVersion
      ) {
        return undefined;
      }

      return await updateTurnState({
        existing,
        fence,
        state: "failed",
        errorMessage: args.errorMessage ?? existing.errorMessage,
      });
    },
  );
}
