import {
  getAgentTurnSessionCheckpoint,
  upsertAgentTurnSessionCheckpoint,
  type AgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import { logException } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  trimTrailingAssistantMessages,
} from "@/chat/respond-helpers";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";

export interface TurnCheckpointContext {
  conversationId?: string;
  sessionId?: string;
}

export interface TurnCheckpointState {
  canUseTurnSession: boolean;
  resumedFromCheckpoint: boolean;
  currentSliceId: number;
  existingCheckpoint?: AgentTurnSessionCheckpoint;
}

interface CheckpointLogContext {
  threadId?: string;
  requesterId?: string;
  channelId?: string;
  runId?: string;
  assistantUserName?: string;
  modelId: string;
}

function logCheckpointError(
  error: unknown,
  eventName: string,
  args: {
    conversationId: string;
    sessionId: string;
    logContext: CheckpointLogContext;
  },
  attributes: Record<string, string | number>,
  message: string,
): void {
  logException(
    error,
    eventName,
    {
      slackThreadId: args.logContext.threadId,
      slackUserId: args.logContext.requesterId,
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

/** Load turn checkpoint state for a conversation/session pair. */
export async function loadTurnCheckpoint(
  ctx: TurnCheckpointContext,
): Promise<TurnCheckpointState> {
  const canUseTurnSession = Boolean(ctx.conversationId && ctx.sessionId);
  const existingCheckpoint =
    canUseTurnSession && ctx.conversationId && ctx.sessionId
      ? await getAgentTurnSessionCheckpoint(ctx.conversationId, ctx.sessionId)
      : undefined;
  const hasAwaitingResumeCheckpoint = Boolean(
    existingCheckpoint &&
    existingCheckpoint.state === "awaiting_resume" &&
    existingCheckpoint.piMessages.length > 0,
  );
  return {
    canUseTurnSession,
    resumedFromCheckpoint: hasAwaitingResumeCheckpoint,
    currentSliceId: hasAwaitingResumeCheckpoint
      ? existingCheckpoint!.sliceId
      : 1,
    existingCheckpoint,
  };
}

/** Persist the latest safe in-progress boundary without scheduling continuation. */
export async function persistRunningCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  sliceId: number;
  messages: PiMessage[];
  loadedSkillNames: string[];
  logContext: CheckpointLogContext;
}): Promise<void> {
  if (args.messages.length === 0 || !isContinuableBoundary(args.messages)) {
    return;
  }

  try {
    const latestCheckpoint = await getAgentTurnSessionCheckpoint(
      args.conversationId,
      args.sessionId,
    );
    await upsertAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
      cumulativeDurationMs: latestCheckpoint?.cumulativeDurationMs,
      cumulativeUsage: latestCheckpoint?.cumulativeUsage,
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: "running",
      piMessages: args.messages,
      loadedSkillNames: args.loadedSkillNames,
    });
  } catch (checkpointError) {
    logCheckpointError(
      checkpointError,
      "agent_turn_running_checkpoint_failed",
      args,
      {
        "app.ai.resume_slice_id": args.sliceId,
      },
      "Failed to persist running turn checkpoint",
    );
  }
}

/** Persist a completed turn checkpoint. */
export async function persistCompletedCheckpoint(args: {
  conversationId: string;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  sessionId: string;
  sliceId: number;
  allMessages: PiMessage[];
  loadedSkillNames: string[];
  logContext: CheckpointLogContext;
}): Promise<void> {
  try {
    const latestCheckpoint = await getAgentTurnSessionCheckpoint(
      args.conversationId,
      args.sessionId,
    );
    await upsertAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
      cumulativeDurationMs: addDurationMs(
        latestCheckpoint?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestCheckpoint?.cumulativeUsage,
        args.currentUsage,
      ),
      sessionId: args.sessionId,
      sliceId: args.sliceId,
      state: "completed",
      piMessages: args.allMessages,
      loadedSkillNames: args.loadedSkillNames,
    });
  } catch (checkpointError) {
    logCheckpointError(
      checkpointError,
      "agent_turn_completed_checkpoint_failed",
      args,
      {
        "app.ai.resume_slice_id": args.sliceId,
      },
      "Failed to persist completed turn checkpoint",
    );
  }
}

/**
 * Persist an auth-pause checkpoint. Returns the durable checkpoint only when
 * the caller can safely hand the user to an authorization resume flow.
 */
export async function persistAuthPauseCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  messages: PiMessage[];
  loadedSkillNames: string[];
  errorMessage: string;
  logContext: CheckpointLogContext;
}): Promise<AgentTurnSessionCheckpoint | undefined> {
  const nextSliceId = args.currentSliceId + 1;
  try {
    const latestCheckpoint = await getAgentTurnSessionCheckpoint(
      args.conversationId,
      args.sessionId,
    );
    const piMessages = trimTrailingAssistantMessages(
      args.messages.length > 0
        ? args.messages
        : (latestCheckpoint?.piMessages ?? []),
    );
    return await upsertAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
      cumulativeDurationMs: addDurationMs(
        latestCheckpoint?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestCheckpoint?.cumulativeUsage,
        args.currentUsage,
      ),
      sessionId: args.sessionId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
      piMessages,
      loadedSkillNames: args.loadedSkillNames,
      resumeReason: "auth",
      resumedFromSliceId: args.currentSliceId,
      errorMessage: args.errorMessage,
    });
  } catch (checkpointError) {
    logCheckpointError(
      checkpointError,
      "agent_turn_auth_resume_checkpoint_failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
      "Failed to persist auth checkpoint before retry",
    );
  }
  return undefined;
}

/**
 * Persist a timeout checkpoint at the last safe boundary. Returns the durable
 * checkpoint when persistence succeeds so callers can enqueue a continuation.
 */
export async function persistTimeoutCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  currentDurationMs?: number;
  currentUsage?: AgentTurnUsage;
  messages: PiMessage[];
  loadedSkillNames: string[];
  errorMessage: string;
  logContext: CheckpointLogContext;
}): Promise<AgentTurnSessionCheckpoint | undefined> {
  const nextSliceId = args.currentSliceId + 1;

  try {
    const latestCheckpoint = await getAgentTurnSessionCheckpoint(
      args.conversationId,
      args.sessionId,
    );
    const piMessages = trimTrailingAssistantMessages(
      args.messages.length > 0
        ? args.messages
        : (latestCheckpoint?.piMessages ?? []),
    );
    return await upsertAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
      cumulativeDurationMs: addDurationMs(
        latestCheckpoint?.cumulativeDurationMs,
        args.currentDurationMs,
      ),
      cumulativeUsage: addAgentTurnUsage(
        latestCheckpoint?.cumulativeUsage,
        args.currentUsage,
      ),
      sessionId: args.sessionId,
      sliceId: nextSliceId,
      state: "awaiting_resume",
      piMessages,
      loadedSkillNames: args.loadedSkillNames,
      resumeReason: "timeout",
      resumedFromSliceId: args.currentSliceId,
      errorMessage: args.errorMessage,
    });
  } catch (checkpointError) {
    logCheckpointError(
      checkpointError,
      "agent_turn_timeout_resume_checkpoint_failed",
      args,
      {
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
      "Failed to persist timeout checkpoint before scheduling resume",
    );
    return undefined;
  }
}
