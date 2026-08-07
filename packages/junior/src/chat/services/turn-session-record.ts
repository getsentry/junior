import {
  getAgentTurnSessionRecord,
  getAgentTurnSessionRecordForResume,
  upsertAgentTurnSessionRecord,
  type AgentDispatchOutcome,
  type AgentTurnSessionRecord,
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

export interface TurnSessionContext {
  conversationId: string;
  sessionId: string;
}

export interface TurnSessionState {
  resumedFromSessionRecord: boolean;
  currentSliceId: number;
  existingSessionRecord?: AgentTurnSessionRecord;
}

function logSessionRecordError(
  error: unknown,
  eventName: string,
  args: {
    conversationId: string;
    sessionId: string;
  },
  attributes: Record<string, string | number>,
): void {
  logException(error, eventName, {
    "app.ai.resume_conversation_id": args.conversationId,
    "app.ai.resume_session_id": args.sessionId,
    ...attributes,
  });
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
 * Choose the latest Pi boundary that can be continued safely after auth pause
 * or timeout, falling back to the last durable record when the current slice
 * ended mid-assistant response.
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

/** Load turn session record state for a conversation/session pair. */
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

/** Persist the latest safe in-progress boundary without scheduling continuation. */
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
  /** Provenance for trailing newly committed messages, such as steering. */
  trailingMessageProvenance?: ConversationMessageProvenance[];
  loadedSkillNames?: string[];
  modelId: string;
  actor?: Actor;
  reasoningLevel?: string;
  surface?: AgentTurnSurface;
  turnContexts?: PluginTurnContext[];
  turnStartMessageIndex?: number;
}): Promise<boolean> {
  if (args.messages.length === 0 || !isContinuablePiBoundary(args.messages)) {
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
      ...(args.destination ? { destination: args.destination } : {}),
      destinationVisibility: args.destinationVisibility,
      ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
        ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
        : {}),
      ...(args.source ? { source: args.source } : {}),
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
      modelId: args.modelId,
      ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      ...(args.turnContexts ? { turnContexts: args.turnContexts } : {}),
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
      "agent.turn.running_session_record.failed",
      args,
      {
        "app.ai.resume_slice_id": args.sliceId,
      },
    );
    return false;
  }
}

/**
 * Commit a run after assistant output handling has settled.
 *
 * Generation completing is not durable completion: call this only after the
 * destination accepted each visible message or intentional silence was
 * resolved. The write is retried because output may already be user-visible;
 * any remaining failure surfaces to the post-output boundary for one
 * authoritative error.
 */
export async function persistCompletedSessionRecord(args: {
  channelName?: string;
  conversationId: string;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  destination?: Destination;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  errorMessage?: string;
  /** Confirmed visibility; omit when unavailable to preserve canonical metadata. */
  destinationVisibility?: ConversationPrivacy;
  /** Provider-owned identifier returned after visible delivery is accepted. */
  resultMessageId?: string;
  source?: Source;
  sessionId: string;
  /** Defaults to the latest stored slice when the deliverer does not know it. */
  sliceId?: number;
  allMessages: PiMessage[];
  loadedSkillNames?: string[];
  modelId: string;
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
  const modelId = args.modelId;
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
    ...(args.destination ? { destination: args.destination } : {}),
    ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
      ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
      : {}),
    ...((args.dispatchOutcome ?? latestSessionRecord?.dispatchOutcome)
      ? {
          dispatchOutcome:
            args.dispatchOutcome ?? latestSessionRecord?.dispatchOutcome,
        }
      : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...((args.resultMessageId ?? latestSessionRecord?.resultMessageId)
      ? {
          resultMessageId:
            args.resultMessageId ?? latestSessionRecord?.resultMessageId,
        }
      : {}),
    ...(args.source ? { source: args.source } : {}),
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
    modelId,
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
  await persistCompletedSessionRecord({
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
    allMessages: args.messages,
    loadedSkillNames: args.loadedSkillNames,
    modelId: args.modelId,
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
    if (piMessages.length > 0 && !isContinuablePiBoundary(piMessages)) {
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
      ...(args.destination ? { destination: args.destination } : {}),
      destinationVisibility: args.destinationVisibility,
      ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
        ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
        : {}),
      ...(args.source ? { source: args.source } : {}),
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
      modelId: args.modelId,
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
      "agent.turn.auth_resume_session_record.failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
    );
  }
  return undefined;
}

interface ContinuationRecordInput {
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
}

/** Persist a timeout or delivery retry under the turn's shared slice limit. */
export async function persistContinuationSessionRecord(
  args: ContinuationRecordInput & {
    resumeReason: "retry" | "timeout";
  },
): Promise<AgentTurnSessionRecord | undefined> {
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
    if (piMessages.length === 0 || !isContinuablePiBoundary(piMessages)) {
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
    if (nextSliceId > botConfig.maxSlicesPerTurn) {
      return await upsertAgentTurnSessionRecord({
        ...((args.channelName ?? latestSessionRecord?.channelName)
          ? {
              channelName: args.channelName ?? latestSessionRecord?.channelName,
            }
          : {}),
        conversationId: args.conversationId,
        cumulativeDurationMs,
        cumulativeUsage,
        ...(args.destination ? { destination: args.destination } : {}),
        destinationVisibility: args.destinationVisibility,
        ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
          ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
          : {}),
        ...(args.source ? { source: args.source } : {}),
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
        modelId: args.modelId,
        ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
          ? {
              reasoningLevel:
                args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
            }
          : {}),
        resumeReason: args.resumeReason,
        resumedFromSliceId: latestSessionRecord?.resumedFromSliceId,
        errorMessage: new TurnSliceLimitExceededError(
          botConfig.maxSlicesPerTurn,
        ).message,
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
      ...(args.destination ? { destination: args.destination } : {}),
      destinationVisibility: args.destinationVisibility,
      ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
        ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
        : {}),
      ...(args.source ? { source: args.source } : {}),
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
      modelId: args.modelId,
      ...((args.reasoningLevel ?? latestSessionRecord?.reasoningLevel)
        ? {
            reasoningLevel:
              args.reasoningLevel ?? latestSessionRecord?.reasoningLevel,
          }
        : {}),
      resumeReason: args.resumeReason,
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
      "agent.continue.session_record.failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
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
  try {
    // Cooperative yield must preserve the exact history boundary. Trimming a
    // delivered assistant message would regenerate and redeliver that reply.
    const piMessages = [...args.messages];
    if (piMessages.length === 0 || !isContinuablePiBoundary(piMessages)) {
      return undefined;
    }
    const latestSessionRecord = await getAgentTurnSessionRecord(
      args.conversationId,
      args.sessionId,
    );
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
      ...(args.destination ? { destination: args.destination } : {}),
      ...((args.dispatchId ?? latestSessionRecord?.dispatchId)
        ? { dispatchId: args.dispatchId ?? latestSessionRecord?.dispatchId }
        : {}),
      ...(args.source ? { source: args.source } : {}),
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
      modelId: args.modelId,
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
      "agent.turn.yield_session_record.failed",
      args,
      {
        "app.ai.resume_slice_id": args.currentSliceId,
      },
    );
    return undefined;
  }
}
