import {
  getAgentTurnSessionCheckpoint,
  upsertAgentTurnSessionCheckpoint,
  type AgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import { logException } from "@/chat/logging";
import { trimTrailingAssistantMessages } from "@/chat/respond-helpers";

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

/** Persist a completed turn checkpoint. */
export async function persistCompletedCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  sliceId: number;
  allMessages: unknown[];
  loadedSkillNames: string[];
}): Promise<void> {
  await upsertAgentTurnSessionCheckpoint({
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: "completed",
    piMessages: args.allMessages,
    loadedSkillNames: args.loadedSkillNames,
  });
}

/**
 * Persist an auth-pause checkpoint. Returns the next slice ID for the caller
 * to throw the appropriate retry error.
 */
export async function persistAuthPauseCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  currentSliceId: number;
  messages: unknown[];
  loadedSkillNames: string[];
  errorMessage: string;
  logContext: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    runId?: string;
    assistantUserName?: string;
    modelId: string;
  };
}): Promise<number> {
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
    await upsertAgentTurnSessionCheckpoint({
      conversationId: args.conversationId,
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
    logException(
      checkpointError,
      "agent_turn_auth_resume_checkpoint_failed",
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
        "app.ai.resume_from_slice_id": args.currentSliceId,
        "app.ai.resume_next_slice_id": nextSliceId,
      },
      "Failed to persist auth checkpoint before retry",
    );
  }
  return nextSliceId;
}
