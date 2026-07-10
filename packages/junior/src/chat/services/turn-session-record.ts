import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
  type AgentTurnSessionRecord,
  type AgentTurnSurface,
} from "@/chat/state/turn-session";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { Destination, Actor, Source } from "@sentry/junior-plugin-api";
import { getActiveTraceId, logException } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import type { PiMessageProvenance } from "@/chat/state/session-log";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { persistWithRetry } from "@/chat/services/persist-retry";

export const AGENT_CONTINUE_MAX_SLICES = 48;

export interface TurnSessionContext {
  conversationId?: string;
  sessionId?: string;
}

export interface TurnSessionState {
  canUseTurnSession: boolean;
  resumedFromSessionRecord: boolean;
  currentSliceId: number;
  existingSessionRecord?: AgentTurnSessionRecord;
}

interface SessionRecordLogContext {
  threadId?: string;
  actorId?: string;
  channelId?: string;
  runId?: string;
  assistantUserName?: string;
  modelId: string;
}

function logSessionRecordError(
  error: unknown,
  eventName: string,
  args: {
    conversationId: string;
    sessionId: string;
    logContext: SessionRecordLogContext;
  },
  attributes: Record<string, string | number>,
  message: string,
): void {
  logException(
    error,
    eventName,
    {
      slackThreadId: args.logContext.threadId,
      slackUserId: args.logContext.actorId,
      slackChannelId: args.logContext.channelId,
      runId: args.logContext.runId,
      assistantUserName: args.logContext.assistantUserName,
      modelId: args.logContext.modelId,
    },
    {
      "app.ai.resume_conversation_id": args.conversationId,
      "app.ai.resume_session_id": args.sessionId,
      ...attributes,
    },
    message,
  );
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

function isContinuableBoundary(messages: PiMessage[]): boolean {
  const lastRole = getPiMessageRole(messages.at(-1));
  return lastRole === "user" || lastRole === "toolResult";
}

/**
 * Choose the latest Pi boundary that can be continued safely after auth pause
 * or timeout, falling back to the last durable record when the current slice
 * ended mid-assistant response.
 */
function resumableBoundary(
  messages: PiMessage[],
  fallbackMessages: PiMessage[] | undefined,
): PiMessage[] {
  const current = trimTrailingAssistantMessages(messages);
  if (current.length > 0 && isContinuableBoundary(current)) {
    return current;
  }
  return trimTrailingAssistantMessages(fallbackMessages ?? []);
}

/** Load turn session record state for a conversation/session pair. */
export async function loadTurnSessionRecord(
  ctx: TurnSessionContext,
): Promise<TurnSessionState> {
  const canUseTurnSession = Boolean(ctx.conversationId && ctx.sessionId);
  const existingSessionRecord =
    canUseTurnSession && ctx.conversationId && ctx.sessionId
      ? await getAgentTurnSessionRecord(ctx.conversationId, ctx.sessionId)
      : undefined;
  const hasAwaitingResumeRecord = Boolean(
    existingSessionRecord && existingSessionRecord.state === "awaiting_resume",
  );
  return {
    canUseTurnSession,
    resumedFromSessionRecord: hasAwaitingResumeRecord,
    currentSliceId: hasAwaitingResumeRecord
      ? existingSessionRecord!.sliceId
      : 1,
    existingSessionRecord,
  };
}

/** Persist the latest safe in-progress boundary without scheduling continuation. */
export async function persistRunningSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  destination?: Destination;
  source?: Source;
  sessionId: string;
  sliceId: number;
  messages: PiMessage[];
  /** Provenance for trailing newly committed messages, such as steering. */
  trailingMessageProvenance?: PiMessageProvenance[];
  loadedSkillNames?: string[];
  logContext: SessionRecordLogContext;
  modelId?: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
}): Promise<boolean> {
  if (args.messages.length === 0 || !isContinuableBoundary(args.messages)) {
    return false;
  }

  try {
    const latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    await upsertAgentTurnSessionRecord({
      ...((args.channelName ?? latestSessionRecord?.channelName)
        ? { channelName: args.channelName ?? latestSessionRecord?.channelName }
        : {}),
      conversationId: args.conversationId,
      cumulativeDurationMs: latestSessionRecord?.cumulativeDurationMs,
      cumulativeUsage: latestSessionRecord?.cumulativeUsage,
      ...((args.destination ?? latestSessionRecord?.destination)
        ? { destination: args.destination ?? latestSessionRecord?.destination }
        : {}),
      ...((args.source ?? latestSessionRecord?.source)
        ? { source: args.source ?? latestSessionRecord?.source }
        : {}),
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: "running",
      piMessages: args.messages,
      ...(args.trailingMessageProvenance
        ? { trailingMessageProvenance: args.trailingMessageProvenance }
        : {}),
      ...((args.surface ?? latestSessionRecord?.surface)
        ? { surface: args.surface ?? latestSessionRecord?.surface }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...(args.modelId ? { modelId: args.modelId } : {}),
      ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      ...((args.actor ?? latestSessionRecord?.actor)
        ? { actor: args.actor ?? latestSessionRecord?.actor }
        : {}),
      ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
        ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
        : {}),
      ...((args.turnStartMessageIndex ??
        latestSessionRecord?.turnStartMessageIndex) !== undefined
        ? {
            turnStartMessageIndex:
              args.turnStartMessageIndex ??
              latestSessionRecord?.turnStartMessageIndex,
          }
        : {}),
    });
    return true;
  } catch (recordError) {
    logSessionRecordError(
      recordError,
      "agent_turn_running_session_record_failed",
      args,
      {
        "app.ai.resume_slice_id": args.sliceId,
      },
      "Failed to persist running turn session record",
    );
    return false;
  }
}

/**
 * Commit the delivered final reply as the terminal completed session record.
 *
 * Generation completing is not delivery: call this only after the destination
 * accepted the visible final reply, so an undelivered assistant reply never
 * becomes durable conversation history or a terminal completed state. The
 * write is retried because the reply is already user-visible, then any remaining
 * failure surfaces to the post-delivery boundary for one authoritative error.
 */
export async function persistCompletedSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  /** Source-confirmed destination visibility from the current event's signal. */
  destinationVisibility?: ConversationPrivacy;
  source?: Source;
  sessionId: string;
  /** Defaults to the latest stored slice when the deliverer does not know it. */
  sliceId?: number;
  allMessages: PiMessage[];
  loadedSkillNames?: string[];
  logContext: SessionRecordLogContext;
  modelId?: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
}): Promise<void> {
  let latestSessionRecord: AgentTurnSessionRecord | undefined;
  await persistWithRetry(async () => {
    latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
  });
  const sliceId = args.sliceId ?? latestSessionRecord?.sliceId;
  if (sliceId === undefined) {
    // Never fabricate a slice-1 completion: a completion without a known
    // slice is a caller bug and must surface as the standard failure path.
    throw new Error(
      "Completed session record requires a slice id from the caller or the latest stored record",
    );
  }
  const modelId =
    latestSessionRecord?.modelId ?? args.modelId ?? args.logContext.modelId;
  const reasoningLevel =
    args.reasoningLevel ?? latestSessionRecord?.reasoningLevel;
  const target: Parameters<typeof upsertAgentTurnSessionRecord>[0] = {
    ...((args.channelName ?? latestSessionRecord?.channelName)
      ? { channelName: args.channelName ?? latestSessionRecord?.channelName }
      : {}),
    conversationId: args.conversationId,
    cumulativeDurationMs: addDurationMs(
      latestSessionRecord?.cumulativeDurationMs,
      args.currentDurationMs,
    ),
    cumulativeUsage: addAgentTurnUsage(
      latestSessionRecord?.cumulativeUsage,
      args.currentUsage,
    ),
    ...((args.destination ?? latestSessionRecord?.destination)
      ? { destination: args.destination ?? latestSessionRecord?.destination }
      : {}),
    ...((args.source ?? latestSessionRecord?.source)
      ? { source: args.source ?? latestSessionRecord?.source }
      : {}),
    ...(args.destinationVisibility
      ? { destinationVisibility: args.destinationVisibility }
      : {}),
    sessionId: args.sessionId,
    sliceId,
    state: "completed",
    piMessages: args.allMessages,
    ...((args.surface ?? latestSessionRecord?.surface)
      ? { surface: args.surface ?? latestSessionRecord?.surface }
      : {}),
    ...((args.loadedSkillNames ?? latestSessionRecord?.loadedSkillNames)
      ? {
          loadedSkillNames:
            args.loadedSkillNames ?? latestSessionRecord?.loadedSkillNames,
        }
      : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...((args.actor ?? latestSessionRecord?.actor)
      ? { actor: args.actor ?? latestSessionRecord?.actor }
      : {}),
    ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
      ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
      : {}),
    ...((args.turnStartMessageIndex ??
      latestSessionRecord?.turnStartMessageIndex) !== undefined
      ? {
          turnStartMessageIndex:
            args.turnStartMessageIndex ??
            latestSessionRecord?.turnStartMessageIndex,
        }
      : {}),
  };
  await persistWithRetry(async () => {
    await upsertAgentTurnSessionRecord(target);
  });
}

/** Complete a delivered single-slice run with an explicit session boundary. */
export async function completeDeliveredTurn(args: {
  channelName?: string;
  conversationId: string;
  destination: Destination;
  destinationVisibility?: ConversationPrivacy;
  durationMs?: number;
  loadedSkillNames?: string[];
  logContext: SessionRecordLogContext;
  messages: PiMessage[];
  actor?: Actor;
  reasoningLevel?: string;
  sessionId: string;
  sliceId: number;
  source: Source;
  surface: AgentTurnSurface;
  turnStartMessageIndex?: number;
  usage?: AgentTurnUsage;
}): Promise<void> {
  await persistCompletedSessionRecord({
    channelName: args.channelName,
    conversationId: args.conversationId,
    currentDurationMs: args.durationMs,
    currentUsage: args.usage,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    source: args.source,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    allMessages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    logContext: args.logContext,
    modelId: args.logContext.modelId,
    actor: args.actor,
    reasoningLevel: args.reasoningLevel,
    surface: args.surface,
    turnStartMessageIndex: args.turnStartMessageIndex,
  });
}

/**
 * Persist an auth-pause session record. Returns the durable record only when
 * the caller can safely hand the user to an authorization resume flow.
 */
export async function persistAuthPauseSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId?: string;
  errorMessage: string;
  logContext: SessionRecordLogContext;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
}): Promise<AgentTurnSessionRecord | undefined> {
  const nextSliceId = args.currentSliceId + 1;
  try {
    const latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    const piMessages = resumableBoundary(
      args.messages,
      latestSessionRecord?.piMessages,
    );
    if (piMessages.length > 0 && !isContinuableBoundary(piMessages)) {
      return undefined;
    }
    return await upsertAgentTurnSessionRecord({
      ...((args.channelName ?? latestSessionRecord?.channelName)
        ? { channelName: args.channelName ?? latestSessionRecord?.channelName }
        : {}),
      conversationId: args.conversationId,
      cumulativeDurationMs: addDurationMs(
        latestSessionRecord?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestSessionRecord?.cumulativeUsage,
        args.currentUsage,
      ),
      ...((args.destination ?? latestSessionRecord?.destination)
        ? { destination: args.destination ?? latestSessionRecord?.destination }
        : {}),
      ...((args.source ?? latestSessionRecord?.source)
        ? { source: args.source ?? latestSessionRecord?.source }
        : {}),
      sessionId: args.sessionId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
      piMessages,
      ...((args.surface ?? latestSessionRecord?.surface)
        ? { surface: args.surface ?? latestSessionRecord?.surface }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...((args.modelId ?? latestSessionRecord?.modelId)
        ? { modelId: args.modelId ?? latestSessionRecord?.modelId }
        : {}),
      ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
          }
        : {}),
      resumeReason: "auth",
      resumedFromSliceId: args.currentSliceId,
      errorMessage: args.errorMessage,
      ...((args.actor ?? latestSessionRecord?.actor)
        ? { actor: args.actor ?? latestSessionRecord?.actor }
        : {}),
      ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
        ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
        : {}),
    });
  } catch (recordError) {
    logSessionRecordError(
      recordError,
      "agent_turn_auth_resume_session_record_failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
      "Failed to persist auth session record before retry",
    );
  }
  return undefined;
}

/**
 * Persist a timeout session record at the last safe boundary. Returns the durable
 * record so callers can distinguish scheduled continuations from terminal caps.
 */
export async function persistTimeoutSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId?: string;
  errorMessage: string;
  logContext: SessionRecordLogContext;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
}): Promise<AgentTurnSessionRecord | undefined> {
  const nextSliceId = args.currentSliceId + 1;

  try {
    const latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    const piMessages = resumableBoundary(
      args.messages,
      latestSessionRecord?.piMessages,
    );
    if (piMessages.length === 0 || !isContinuableBoundary(piMessages)) {
      return undefined;
    }
    const cumulativeDurationMs = addDurationMs(
      latestSessionRecord?.cumulativeDurationMs,
      args.currentDurationMs,
    );
    const cumulativeUsage = addAgentTurnUsage(
      latestSessionRecord?.cumulativeUsage,
      args.currentUsage,
    );
    if (nextSliceId > AGENT_CONTINUE_MAX_SLICES) {
      return await upsertAgentTurnSessionRecord({
        ...((args.channelName ?? latestSessionRecord?.channelName)
          ? {
              channelName: args.channelName ?? latestSessionRecord?.channelName,
            }
          : {}),
        conversationId: args.conversationId,
        cumulativeDurationMs,
        cumulativeUsage,
        ...((args.destination ?? latestSessionRecord?.destination)
          ? {
              destination: args.destination ?? latestSessionRecord?.destination,
            }
          : {}),
        ...((args.source ?? latestSessionRecord?.source)
          ? { source: args.source ?? latestSessionRecord?.source }
          : {}),
        sessionId: args.sessionId,
        sliceId: args.currentSliceId,
        state: "failed",
        piMessages,
        ...((args.surface ?? latestSessionRecord?.surface)
          ? { surface: args.surface ?? latestSessionRecord?.surface }
          : {}),
        ...(args.loadedSkillNames
          ? { loadedSkillNames: args.loadedSkillNames }
          : {}),
        ...((args.modelId ?? latestSessionRecord?.modelId)
          ? { modelId: args.modelId ?? latestSessionRecord?.modelId }
          : {}),
        ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
          ? {
              reasoningLevel:
                args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
            }
          : {}),
        resumeReason: "timeout",
        resumedFromSliceId: latestSessionRecord?.resumedFromSliceId,
        errorMessage: `Agent continuation exceeded slice limit (${AGENT_CONTINUE_MAX_SLICES})`,
        ...((args.actor ?? latestSessionRecord?.actor)
          ? { actor: args.actor ?? latestSessionRecord?.actor }
          : {}),
        ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
          ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
          : {}),
      });
    }
    return await upsertAgentTurnSessionRecord({
      ...((args.channelName ?? latestSessionRecord?.channelName)
        ? { channelName: args.channelName ?? latestSessionRecord?.channelName }
        : {}),
      conversationId: args.conversationId,
      cumulativeDurationMs,
      cumulativeUsage,
      ...((args.destination ?? latestSessionRecord?.destination)
        ? { destination: args.destination ?? latestSessionRecord?.destination }
        : {}),
      ...((args.source ?? latestSessionRecord?.source)
        ? { source: args.source ?? latestSessionRecord?.source }
        : {}),
      sessionId: args.sessionId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
      piMessages,
      ...((args.surface ?? latestSessionRecord?.surface)
        ? { surface: args.surface ?? latestSessionRecord?.surface }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...((args.modelId ?? latestSessionRecord?.modelId)
        ? { modelId: args.modelId ?? latestSessionRecord?.modelId }
        : {}),
      ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
          }
        : {}),
      resumeReason: "timeout",
      resumedFromSliceId: args.currentSliceId,
      errorMessage: args.errorMessage,
      ...((args.actor ?? latestSessionRecord?.actor)
        ? { actor: args.actor ?? latestSessionRecord?.actor }
        : {}),
      ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
        ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
        : {}),
    });
  } catch (recordError) {
    logSessionRecordError(
      recordError,
      "agent_continue_session_record_failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
      "Failed to persist session record before scheduling agent continuation",
    );
    return undefined;
  }
}

/**
 * Persist a cooperative-yield boundary without advancing timeout slice counts.
 */
export async function persistYieldSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  source?: Source;
  messages: PiMessage[];
  loadedSkillNames?: string[];
  modelId?: string;
  errorMessage: string;
  logContext: SessionRecordLogContext;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
}): Promise<AgentTurnSessionRecord | undefined> {
  try {
    const latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
    const piMessages = resumableBoundary(
      args.messages,
      latestSessionRecord?.piMessages,
    );
    if (piMessages.length === 0 || !isContinuableBoundary(piMessages)) {
      return undefined;
    }
    return await upsertAgentTurnSessionRecord({
      ...((args.channelName ?? latestSessionRecord?.channelName)
        ? { channelName: args.channelName ?? latestSessionRecord?.channelName }
        : {}),
      conversationId: args.conversationId,
      cumulativeDurationMs: addDurationMs(
        latestSessionRecord?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestSessionRecord?.cumulativeUsage,
        args.currentUsage,
      ),
      ...((args.destination ?? latestSessionRecord?.destination)
        ? { destination: args.destination ?? latestSessionRecord?.destination }
        : {}),
      ...((args.source ?? latestSessionRecord?.source)
        ? { source: args.source ?? latestSessionRecord?.source }
        : {}),
      sessionId: args.sessionId,
      sliceId: args.currentSliceId,
      state: "awaiting_resume",
      piMessages,
      ...((args.surface ?? latestSessionRecord?.surface)
        ? { surface: args.surface ?? latestSessionRecord?.surface }
        : {}),
      ...(args.loadedSkillNames
        ? { loadedSkillNames: args.loadedSkillNames }
        : {}),
      ...((args.modelId ?? latestSessionRecord?.modelId)
        ? { modelId: args.modelId ?? latestSessionRecord?.modelId }
        : {}),
      ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
          }
        : {}),
      resumeReason: "yield",
      resumedFromSliceId: latestSessionRecord?.resumedFromSliceId,
      errorMessage: args.errorMessage,
      ...((args.actor ?? latestSessionRecord?.actor)
        ? { actor: args.actor ?? latestSessionRecord?.actor }
        : {}),
      ...((getActiveTraceId() ?? latestSessionRecord?.traceId)
        ? { traceId: getActiveTraceId() ?? latestSessionRecord?.traceId }
        : {}),
    });
  } catch (recordError) {
    logSessionRecordError(
      recordError,
      "agent_turn_yield_session_record_failed",
      args,
      {
        "app.ai.resume_slice_id": args.currentSliceId,
      },
      "Failed to persist cooperative yield session record",
    );
    return undefined;
  }
}
