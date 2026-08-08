/**
 * Turn checkpoints.
 *
 * One write path for progress during a turn:
 * - `running`: mid-turn safe boundary (best-effort)
 * - `paused`: stop and wait (auth / timeout / yield / retry)
 * - `completed` / `failed`: turn finished
 *
 * History lives in SQL via `commitMessages`. This module only stores the thin
 * resume cursor + status in Redis.
 */
import {
  getAgentTurnSessionRecord,
  getAgentTurnSessionRecordForResume,
  upsertAgentTurnSessionRecord,
  type AgentDispatchOutcome,
  type AgentTurnResumeReason,
  type AgentTurnSessionRecord,
  type AgentTurnSessionStatus,
  type AgentTurnSurface,
} from "@/chat/state/turn-session";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { Destination, Actor, Source } from "@sentry/junior-plugin-api";
import { getActiveTraceId, logException } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import {
  isContinuablePiBoundary,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";
import { botConfig } from "@/chat/config";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import { AgentHistoryBranchError } from "@/chat/conversations/projection";

export interface TurnSessionContext {
  conversationId: string;
  sessionId: string;
}

export interface TurnSessionState {
  resumedFromSessionRecord: boolean;
  currentSliceId: number;
  existingSessionRecord?: AgentTurnSessionRecord;
}

/** Shared fields for every checkpoint write. */
export interface TurnCheckpointBase {
  channelName?: string;
  conversationId: string;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  source?: Source;
  sessionId: string;
  messages: PiMessage[];
  modelId: string;
  actor?: Actor;
  loadedSkillNames?: string[];
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
  trailingMessageProvenance?: ConversationMessageProvenance[];
  turnContexts?: PluginTurnContext[];
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  errorMessage?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  resultMessageId?: string;
}

export type TurnCheckpointInput =
  | (TurnCheckpointBase & {
      mode: "running";
      sliceId: number;
    })
  | (TurnCheckpointBase & {
      mode: "paused";
      reason: AgentTurnResumeReason;
      sliceId: number;
      /** When true, keep the current slice id (cooperative yield). */
      keepSlice?: boolean;
    })
  | (TurnCheckpointBase & {
      mode: "completed" | "failed";
      /** Defaults to the latest stored slice when omitted. */
      sliceId?: number;
    });

type UpsertTurnSessionRecord = Parameters<
  typeof upsertAgentTurnSessionRecord
>[0];

/** Keep only keys whose value is defined. */
function definedProps<T extends Record<string, unknown>>(
  values: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function addDurationMs(
  prior: number | undefined,
  current: number | undefined,
): number | undefined {
  const total = [prior, current].reduce<number | undefined>((sum, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return sum;
    }
    return (sum ?? 0) + Math.max(0, Math.floor(value));
  }, undefined);
  return total;
}

/**
 * Choose the latest boundary that can be continued after auth/timeout.
 * Falls back to the last durable record when the current slice ended mid-assistant.
 */
function resumableBoundary(
  messages: PiMessage[],
  fallbackMessages: PiMessage[] | undefined,
): PiMessage[] {
  const current = trimTrailingAssistantMessages(messages);
  if (current.length > 0 && isContinuablePiBoundary(current)) {
    return current;
  }
  return trimTrailingAssistantMessages(fallbackMessages ?? []);
}

function logCheckpointError(
  error: unknown,
  eventName: string,
  args: { conversationId: string; sessionId: string },
  attributes: Record<string, string | number> = {},
): void {
  logException(error, eventName, {
    "app.ai.resume_conversation_id": args.conversationId,
    "app.ai.resume_session_id": args.sessionId,
    ...attributes,
  });
}

function writeFields(
  args: TurnCheckpointBase,
  latest?: AgentTurnSessionRecord,
): Pick<
  UpsertTurnSessionRecord,
  | "actor"
  | "channelName"
  | "conversationId"
  | "destination"
  | "destinationVisibility"
  | "dispatchId"
  | "loadedSkillNames"
  | "modelId"
  | "reasoningLevel"
  | "sessionId"
  | "source"
  | "surface"
  | "traceId"
  | "turnStartMessageIndex"
> {
  return {
    conversationId: args.conversationId,
    modelId: args.modelId,
    sessionId: args.sessionId,
    ...definedProps({
      actor: args.actor,
      channelName: args.channelName ?? latest?.channelName,
      destination: args.destination,
      destinationVisibility: args.destinationVisibility,
      dispatchId: args.dispatchId ?? latest?.dispatchId,
      loadedSkillNames: args.loadedSkillNames,
      reasoningLevel: args.reasoningLevel,
      source: args.source,
      surface: args.surface ?? latest?.surface,
      traceId: getActiveTraceId() ?? latest?.traceId,
      turnStartMessageIndex:
        args.turnStartMessageIndex ?? latest?.turnStartMessageIndex,
    }),
  };
}

/** Load turn checkpoint state for a conversation/session pair. */
export async function loadTurnSessionRecord(
  ctx: TurnSessionContext,
): Promise<TurnSessionState> {
  const existingSessionRecord = await getAgentTurnSessionRecordForResume(
    ctx.conversationId,
    ctx.sessionId,
  );
  const hasAwaitingResumeRecord = Boolean(
    existingSessionRecord && existingSessionRecord.state === "awaiting_resume",
  );
  return {
    resumedFromSessionRecord: hasAwaitingResumeRecord,
    currentSliceId: hasAwaitingResumeRecord
      ? existingSessionRecord!.sliceId
      : 1,
    existingSessionRecord,
  };
}

/**
 * Save turn progress.
 *
 * Returns the stored record, or `undefined` when a best-effort running/paused
 * write could not land a continuable boundary. Completed/failed writes throw.
 */
export async function saveTurnCheckpoint(
  args: TurnCheckpointInput,
): Promise<AgentTurnSessionRecord | undefined> {
  if (args.mode === "running") {
    return await saveRunningCheckpoint(args);
  }
  if (args.mode === "paused") {
    return await savePausedCheckpoint(args);
  }
  return await saveTerminalCheckpoint(args);
}

async function saveRunningCheckpoint(
  args: Extract<TurnCheckpointInput, { mode: "running" }>,
): Promise<AgentTurnSessionRecord | undefined> {
  if (args.messages.length === 0 || !isContinuablePiBoundary(args.messages)) {
    return undefined;
  }

  try {
    const latest = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    return await upsertAgentTurnSessionRecord({
      ...writeFields(args, latest),
      ...definedProps({
        trailingMessageProvenance: args.trailingMessageProvenance,
        turnContexts: args.turnContexts,
      }),
      cumulativeDurationMs: latest?.cumulativeDurationMs,
      cumulativeUsage: latest?.cumulativeUsage,
      piMessages: args.messages,
      sliceId: args.sliceId,
      state: "running",
    });
  } catch (error) {
    // A stale async checkpoint can lose a race to a later committed boundary.
    // Quiet only that case — durable history remains authoritative.
    if (!(error instanceof AgentHistoryBranchError)) {
      logCheckpointError(error, "agent.turn.checkpoint.running.failed", args, {
        "app.ai.resume_slice_id": args.sliceId,
      });
    }
    return undefined;
  }
}

async function savePausedCheckpoint(
  args: Extract<TurnCheckpointInput, { mode: "paused" }>,
): Promise<AgentTurnSessionRecord | undefined> {
  const keepSlice = args.keepSlice === true || args.reason === "yield";
  const nextSliceId = keepSlice ? args.sliceId : args.sliceId + 1;

  try {
    const latest = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );

    // Cooperative yield must keep the exact boundary (including delivered
    // assistant text). Auth/timeout may trim a mid-assistant tail.
    const piMessages =
      args.reason === "yield"
        ? [...args.messages]
        : resumableBoundary(args.messages, latest?.piMessages);

    if (args.reason === "auth") {
      if (piMessages.length > 0 && !isContinuablePiBoundary(piMessages)) {
        return undefined;
      }
    } else if (
      piMessages.length === 0 ||
      !isContinuablePiBoundary(piMessages)
    ) {
      return undefined;
    }

    const shared = {
      ...writeFields(args, latest),
      ...definedProps({
        cumulativeDurationMs: addDurationMs(
          latest?.cumulativeDurationMs,
          args.currentDurationMs,
        ),
        cumulativeUsage: addAgentTurnUsage(
          latest?.cumulativeUsage,
          args.currentUsage,
        ),
        errorMessage: args.errorMessage,
      }),
      piMessages,
      resumeReason: args.reason,
    } satisfies Partial<UpsertTurnSessionRecord>;

    if (!keepSlice && nextSliceId > botConfig.maxSlicesPerTurn) {
      return await upsertAgentTurnSessionRecord({
        ...shared,
        ...definedProps({
          resumedFromSliceId: latest?.resumedFromSliceId,
        }),
        errorMessage: new TurnSliceLimitExceededError(
          botConfig.maxSlicesPerTurn,
        ).message,
        sliceId: args.sliceId,
        state: "failed",
      });
    }

    return await upsertAgentTurnSessionRecord({
      ...shared,
      ...definedProps({
        resumedFromSliceId: keepSlice
          ? latest?.resumedFromSliceId
          : args.sliceId,
      }),
      sliceId: nextSliceId,
      state: "awaiting_resume",
    });
  } catch (error) {
    logCheckpointError(error, "agent.turn.checkpoint.paused.failed", args, {
      "app.ai.resume_from_slice_id": args.sliceId,
      "app.ai.resume_next_slice_id": nextSliceId,
      "app.ai.resume_reason": args.reason,
    });
    return undefined;
  }
}

async function saveTerminalCheckpoint(
  args: Extract<TurnCheckpointInput, { mode: "completed" | "failed" }>,
): Promise<AgentTurnSessionRecord | undefined> {
  let latest: AgentTurnSessionRecord | undefined;
  await persistWithRetry(async () => {
    latest = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
  });
  const sliceId = args.sliceId ?? latest?.sliceId;
  if (sliceId === undefined) {
    throw new Error(
      "Completed turn checkpoint requires a slice id from the caller or the latest stored record",
    );
  }

  const target: UpsertTurnSessionRecord = {
    ...writeFields(args, latest),
    ...definedProps({
      cumulativeDurationMs: addDurationMs(
        latest?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latest?.cumulativeUsage,
        args.currentUsage,
      ),
      dispatchOutcome: args.dispatchOutcome ?? latest?.dispatchOutcome,
      errorMessage: args.errorMessage,
      resultMessageId: args.resultMessageId ?? latest?.resultMessageId,
    }),
    piMessages: args.messages,
    sliceId,
    state: args.mode satisfies AgentTurnSessionStatus,
  };

  // Retry until the write accepts; callers care that terminal state landed,
  // not that the upsert echo is present.
  await persistWithRetry(async () => {
    await upsertAgentTurnSessionRecord(target);
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Compatibility shims — thin wrappers over saveTurnCheckpoint.
// Callers should migrate to saveTurnCheckpoint; these stay until that lands.
// ---------------------------------------------------------------------------

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "running", ... })`. */
export async function persistRunningSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  source?: Source;
  sessionId: string;
  sliceId: number;
  messages: PiMessage[];
  trailingMessageProvenance?: ConversationMessageProvenance[];
  loadedSkillNames?: string[];
  modelId: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnContexts?: PluginTurnContext[];
  turnStartMessageIndex?: number;
}): Promise<boolean> {
  const saved = await saveTurnCheckpoint({
    mode: "running",
    ...args,
  });
  return Boolean(saved);
}

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "completed", ... })`. */
export async function persistCompletedSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  errorMessage?: string;
  destinationVisibility?: ConversationPrivacy;
  resultMessageId?: string;
  source?: Source;
  sessionId: string;
  sliceId?: number;
  allMessages: PiMessage[];
  loadedSkillNames?: string[];
  modelId: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
}): Promise<void> {
  // Terminal deliveries stay `completed` even when diagnostics carry an error
  // message — failure vs success is owned by dispatchOutcome/diagnostics.
  await saveTurnCheckpoint({
    mode: "completed",
    channelName: args.channelName,
    conversationId: args.conversationId,
    currentDurationMs: args.currentDurationMs,
    currentUsage: args.currentUsage,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    dispatchId: args.dispatchId,
    dispatchOutcome: args.dispatchOutcome,
    errorMessage: args.errorMessage,
    resultMessageId: args.resultMessageId,
    source: args.source,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    messages: args.allMessages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
    turnStartMessageIndex: args.turnStartMessageIndex,
  });
}

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "completed", ... })`. */
export async function completeDeliveredTurn(args: {
  channelName?: string;
  conversationId: string;
  destination: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  errorMessage?: string;
  durationMs?: number;
  loadedSkillNames?: string[];
  messages: PiMessage[];
  modelId: string;
  actor?: Actor;
  reasoningLevel?: string;
  resultMessageId?: string;
  sessionId: string;
  sliceId: number;
  source: Source;
  surface: AgentTurnSurface;
  turnStartMessageIndex?: number;
  usage?: AgentTurnUsage;
}): Promise<void> {
  await saveTurnCheckpoint({
    mode: "completed",
    channelName: args.channelName,
    conversationId: args.conversationId,
    currentDurationMs: args.durationMs,
    currentUsage: args.usage,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    dispatchId: args.dispatchId,
    dispatchOutcome: args.dispatchOutcome,
    errorMessage: args.errorMessage,
    resultMessageId: args.resultMessageId,
    source: args.source,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    messages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
    turnStartMessageIndex: args.turnStartMessageIndex,
  });
}

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "paused", reason: "auth", ... })`. */
export async function persistAuthPauseSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId: string;
  errorMessage: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
}): Promise<AgentTurnSessionRecord | undefined> {
  return await saveTurnCheckpoint({
    mode: "paused",
    reason: "auth",
    sliceId: args.currentSliceId,
    channelName: args.channelName,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    currentDurationMs: args.currentDurationMs,
    currentUsage: args.currentUsage,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    dispatchId: args.dispatchId,
    source: args.source,
    messages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
    errorMessage: args.errorMessage,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
  });
}

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "paused", reason: "timeout"|"retry", ... })`. */
export async function persistContinuationSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId: string;
  errorMessage: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  resumeReason: "retry" | "timeout";
}): Promise<AgentTurnSessionRecord | undefined> {
  return await saveTurnCheckpoint({
    mode: "paused",
    reason: args.resumeReason,
    sliceId: args.currentSliceId,
    channelName: args.channelName,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    currentDurationMs: args.currentDurationMs,
    currentUsage: args.currentUsage,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    dispatchId: args.dispatchId,
    source: args.source,
    messages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
    errorMessage: args.errorMessage,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
  });
}

/** @deprecated Prefer `saveTurnCheckpoint({ mode: "paused", reason: "yield", keepSlice: true, ... })`. */
export async function persistYieldSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId: string;
  errorMessage: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
}): Promise<AgentTurnSessionRecord | undefined> {
  return await saveTurnCheckpoint({
    mode: "paused",
    reason: "yield",
    keepSlice: true,
    sliceId: args.currentSliceId,
    channelName: args.channelName,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    currentDurationMs: args.currentDurationMs,
    currentUsage: args.currentUsage,
    destination: args.destination,
    dispatchId: args.dispatchId,
    source: args.source,
    messages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
    errorMessage: args.errorMessage,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
  });
}
