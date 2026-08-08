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

/**
 * Shared optional fields carried across turn-session writes.
 * Callers resolve inheritance for skill/reasoning fields before calling.
 * Routing/identity fields are live-only for SQL dual-write — Redis no longer
 * stores destination/source/actor on the turn-session projection.
 */
interface TurnSessionWriteContext {
  actor?: Actor;
  channelName?: string;
  conversationId: string;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  loadedSkillNames?: string[];
  modelId: string;
  reasoningLevel?: string;
  sessionId: string;
  source?: Source;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
}

function sessionWriteContext(
  args: TurnSessionWriteContext,
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
      // Live only: Redis no longer stores execution actor across resumes.
      actor: args.actor,
      channelName: args.channelName ?? latest?.channelName,
      destination: args.destination,
      destinationVisibility: args.destinationVisibility,
      dispatchId: args.dispatchId ?? latest?.dispatchId,
      // Caller-resolved: some paths inherit these, others stay caller-only.
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
    // Running checkpoints keep caller-owned skill/reasoning values only.
    await upsertAgentTurnSessionRecord({
      ...sessionWriteContext(
        {
          actor: args.actor,
          channelName: args.channelName,
          conversationId: args.conversationId,
          destination: args.destination,
          destinationVisibility: args.destinationVisibility,
          dispatchId: args.dispatchId,
          loadedSkillNames: args.loadedSkillNames,
          modelId: args.modelId,
          reasoningLevel: args.reasoningLevel,
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
          turnStartMessageIndex: args.turnStartMessageIndex,
        },
        latestSessionRecord,
      ),
      ...definedProps({
        trailingMessageProvenance: args.trailingMessageProvenance,
        turnContexts: args.turnContexts,
      }),
      cumulativeDurationMs: latestSessionRecord?.cumulativeDurationMs,
      cumulativeUsage: latestSessionRecord?.cumulativeUsage,
      piMessages: args.messages,
      sliceId: args.sliceId,
      state: "running",
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
  const target: UpsertTurnSessionRecord = {
    ...sessionWriteContext(
      {
        actor: args.actor,
        channelName: args.channelName,
        conversationId: args.conversationId,
        destination: args.destination,
        destinationVisibility: args.destinationVisibility,
        dispatchId: args.dispatchId,
        loadedSkillNames: args.loadedSkillNames,
        modelId: args.modelId,
        reasoningLevel: args.reasoningLevel,
        sessionId: args.sessionId,
        source: args.source,
        surface: args.surface,
        turnStartMessageIndex: args.turnStartMessageIndex,
      },
      latestSessionRecord,
    ),
    ...definedProps({
      cumulativeDurationMs: addDurationMs(
        latestSessionRecord?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestSessionRecord?.cumulativeUsage,
        args.currentUsage,
      ),
      dispatchOutcome:
        args.dispatchOutcome ?? latestSessionRecord?.dispatchOutcome,
      errorMessage: args.errorMessage,
      resultMessageId:
        args.resultMessageId ?? latestSessionRecord?.resultMessageId,
    }),
    piMessages: args.allMessages,
    sliceId,
    state: "completed",
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
      ...sessionWriteContext(
        {
          actor: args.actor,
          channelName: args.channelName,
          conversationId: args.conversationId,
          destination: args.destination,
          destinationVisibility: args.destinationVisibility,
          dispatchId: args.dispatchId,
          // Auth-pause keeps caller-owned skill names only.
          loadedSkillNames: args.loadedSkillNames,
          modelId: args.modelId,
          reasoningLevel: args.reasoningLevel,
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
        },
        latestSessionRecord,
      ),
      ...definedProps({
        cumulativeDurationMs: addDurationMs(
          latestSessionRecord?.cumulativeDurationMs,
          args.currentDurationMs,
        ),
        cumulativeUsage: addAgentTurnUsage(
          latestSessionRecord?.cumulativeUsage,
          args.currentUsage,
        ),
      }),
      errorMessage: args.errorMessage,
      piMessages,
      resumeReason: "auth",
      resumedFromSliceId: args.currentSliceId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
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
    const shared = {
      ...sessionWriteContext(
        {
          actor: args.actor,
          channelName: args.channelName,
          conversationId: args.conversationId,
          destination: args.destination,
          destinationVisibility: args.destinationVisibility,
          dispatchId: args.dispatchId,
          // Continuation keeps caller-owned skill names only.
          loadedSkillNames: args.loadedSkillNames,
          modelId: args.modelId,
          reasoningLevel: args.reasoningLevel,
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
        },
        latestSessionRecord,
      ),
      ...definedProps({
        cumulativeDurationMs,
        cumulativeUsage,
      }),
      piMessages,
      resumeReason: args.resumeReason,
    } satisfies Partial<UpsertTurnSessionRecord>;

    if (nextSliceId > botConfig.maxSlicesPerTurn) {
      return await upsertAgentTurnSessionRecord({
        ...shared,
        ...definedProps({
          resumedFromSliceId: latestSessionRecord?.resumedFromSliceId,
        }),
        errorMessage: new TurnSliceLimitExceededError(
          botConfig.maxSlicesPerTurn,
        ).message,
        sliceId: args.currentSliceId,
        state: "failed",
      });
    }
    return await upsertAgentTurnSessionRecord({
      ...shared,
      errorMessage: args.errorMessage,
      resumedFromSliceId: args.currentSliceId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
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
      ...sessionWriteContext(
        {
          actor: args.actor,
          channelName: args.channelName,
          conversationId: args.conversationId,
          destination: args.destination,
          dispatchId: args.dispatchId,
          // Yield keeps caller-owned skill names only.
          loadedSkillNames: args.loadedSkillNames,
          modelId: args.modelId,
          reasoningLevel: args.reasoningLevel,
          sessionId: args.sessionId,
          source: args.source,
          surface: args.surface,
        },
        latestSessionRecord,
      ),
      ...definedProps({
        cumulativeDurationMs: addDurationMs(
          latestSessionRecord?.cumulativeDurationMs,
          args.currentDurationMs,
        ),
        cumulativeUsage: addAgentTurnUsage(
          latestSessionRecord?.cumulativeUsage,
          args.currentUsage,
        ),
        resumedFromSliceId: latestSessionRecord?.resumedFromSliceId,
      }),
      errorMessage: args.errorMessage,
      piMessages,
      resumeReason: "yield",
      sliceId: args.currentSliceId,
      state: "awaiting_resume",
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
