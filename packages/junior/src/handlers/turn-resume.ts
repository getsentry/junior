import { logException, logWarn } from "@/chat/logging";
import {
  ResumeTurnBusyError,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  failAgentTurnSessionCheckpoint,
  getAgentTurnSessionCheckpoint,
  type AgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import {
  getPersistedThreadState,
  getPersistedSandboxState,
  persistThreadStateById,
  getChannelConfigurationServiceById,
} from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getTurnUserMessage,
  getTurnUserReplyAttachmentContext,
  getTurnUserSlackMessageTs,
} from "@/chat/runtime/turn-user-message";
import {
  buildConversationContext,
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { isRetryableTurnError, markTurnFailed } from "@/chat/runtime/turn";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
  verifyTurnTimeoutResumeRequest,
  type TurnContinuationRequest,
} from "@/chat/services/timeout-resume";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { AssistantReply } from "@/chat/respond";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
} from "@/chat/services/pending-auth";
import type { WaitUntilFn } from "@/handlers/types";

const TIMEOUT_RESUME_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistCompletedReplyState(args: {
  checkpoint: AgentTurnSessionCheckpoint;
  reply: AssistantReply;
}): Promise<void> {
  const currentState = await getPersistedThreadState(
    args.checkpoint.conversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(
    conversation,
    args.checkpoint.sessionId,
  );
  const statePatch = buildDeliveredTurnStatePatch({
    artifacts,
    conversation,
    reply: args.reply,
    sessionId: args.checkpoint.sessionId,
    userMessageId: userMessage?.id,
  });

  await persistThreadStateById(args.checkpoint.conversationId, {
    ...statePatch,
  });
}

async function failCheckpointBestEffort(args: {
  checkpoint: AgentTurnSessionCheckpoint;
  errorMessage: string;
}): Promise<void> {
  try {
    await failAgentTurnSessionCheckpoint({
      conversationId: args.checkpoint.conversationId,
      expectedCheckpointVersion: args.checkpoint.checkpointVersion,
      sessionId: args.checkpoint.sessionId,
      errorMessage: args.errorMessage,
    });
  } catch (error) {
    logException(
      error,
      "timeout_resume_checkpoint_fail_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.checkpoint.conversationId,
        "app.ai.session_id": args.checkpoint.sessionId,
      },
      "Failed to mark timed-out turn checkpoint failed",
    );
  }
}

async function persistFailedReplyState(
  checkpoint: AgentTurnSessionCheckpoint,
): Promise<void> {
  const currentState = await getPersistedThreadState(checkpoint.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  clearPendingAuth(conversation, checkpoint.sessionId);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: checkpoint.sessionId,
    userMessageId: getTurnUserMessage(conversation, checkpoint.sessionId)?.id,
    markConversationMessage,
    updateConversationStats,
  });

  await failCheckpointBestEffort({
    checkpoint,
    errorMessage: "Timed-out turn failed while resuming",
  });
  await persistThreadStateById(checkpoint.conversationId, {
    conversation,
  });
}

async function resumeTimedOutTurn(
  payload: TurnContinuationRequest,
): Promise<void> {
  const thread = parseSlackThreadId(payload.conversationId);
  if (!thread) {
    throw new Error(
      `Timeout resume requires a Slack thread conversation id, got "${payload.conversationId}"`,
    );
  }

  await resumeSlackTurn({
    messageText: "",
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    lockKey: payload.conversationId,
    beforeStart: async () => {
      const checkpoint = await getAgentTurnSessionCheckpoint(
        payload.conversationId,
        payload.sessionId,
      );
      if (
        !checkpoint ||
        checkpoint.state !== "awaiting_resume" ||
        checkpoint.resumeReason !== "timeout" ||
        checkpoint.checkpointVersion !== payload.expectedCheckpointVersion
      ) {
        return false;
      }

      const currentState = await getPersistedThreadState(
        payload.conversationId,
      );
      const conversation = coerceThreadConversationState(currentState);
      const artifacts = coerceThreadArtifactsState(currentState);
      const userMessage = getTurnUserMessage(conversation, payload.sessionId);
      if (!userMessage?.author?.userId) {
        throw new Error(
          `Unable to locate the persisted user message for timeout resume session "${payload.sessionId}"`,
        );
      }
      if (conversation.processing.activeTurnId !== payload.sessionId) {
        return false;
      }

      const channelConfiguration = getChannelConfigurationServiceById(
        thread.channelId,
      );
      const conversationContext = buildConversationContext(conversation, {
        excludeMessageId: userMessage.id,
      });
      const sandbox = getPersistedSandboxState(currentState);

      return {
        messageText: userMessage.text,
        messageTs: getTurnUserSlackMessageTs(userMessage),
        replyContext: {
          requester: {
            userId: userMessage.author.userId,
            userName: userMessage.author.userName,
            fullName: userMessage.author.fullName,
          },
          correlation: {
            conversationId: payload.conversationId,
            turnId: payload.sessionId,
            channelId: thread.channelId,
            threadTs: thread.threadTs,
            requesterId: userMessage.author.userId,
          },
          toolChannelId:
            artifacts.assistantContextChannelId ?? thread.channelId,
          artifactState: artifacts,
          pendingAuth: conversation.processing.pendingAuth,
          conversationContext,
          channelConfiguration,
          piMessages: conversation.piMessages,
          sandbox,
          onAuthPending: async (nextPendingAuth) => {
            await applyPendingAuthUpdate({
              conversation,
              conversationId: payload.conversationId,
              nextPendingAuth,
            });
            await persistThreadStateById(payload.conversationId, {
              conversation,
            });
          },
          ...getTurnUserReplyAttachmentContext(userMessage),
        },
        onSuccess: async (reply: AssistantReply) => {
          await persistCompletedReplyState({ checkpoint, reply });
        },
        onFailure: async () => {
          await persistFailedReplyState(checkpoint);
        },
        onPostDeliveryCommitFailure: async () => {
          await failAgentTurnSessionCheckpoint({
            conversationId: checkpoint.conversationId,
            expectedCheckpointVersion: checkpoint.checkpointVersion,
            sessionId: checkpoint.sessionId,
            errorMessage:
              "Timed-out turn reply was delivered but completion state did not persist",
          });
        },
        onAuthPause: async () => {
          await persistAuthPauseTurnState({
            sessionId: payload.sessionId,
            threadStateId: payload.conversationId,
          });
          logWarn(
            "timeout_resume_reparked_for_auth",
            {},
            {
              "app.ai.conversation_id": payload.conversationId,
              "app.ai.session_id": payload.sessionId,
            },
            "Resumed timed-out turn parked for auth",
          );
        },
        onTimeoutPause: async (error: unknown) => {
          if (!isRetryableTurnError(error, "turn_timeout_resume")) {
            throw error;
          }
          const checkpointVersion = error.metadata?.checkpointVersion;
          const nextSliceId = error.metadata?.sliceId;
          if (typeof checkpointVersion !== "number") {
            throw new Error(
              "Timed-out resume turn did not include a checkpoint version",
            );
          }
          if (!canScheduleTurnTimeoutResume(nextSliceId)) {
            logWarn(
              "timeout_resume_slice_limit_reached",
              {},
              {
                "app.ai.conversation_id": payload.conversationId,
                "app.ai.session_id": payload.sessionId,
                ...(typeof nextSliceId === "number"
                  ? { "app.ai.resume_slice_id": nextSliceId }
                  : {}),
              },
              "Skipped automatic timeout resume because the turn exceeded the slice limit",
            );
            throw new Error(
              "Timed-out turn exceeded the automatic resume slice limit",
            );
          }

          await scheduleTurnTimeoutResume({
            conversationId: payload.conversationId,
            sessionId: payload.sessionId,
            expectedCheckpointVersion: checkpointVersion,
          });
        },
      };
    },
  });
}

async function resumeTimedOutTurnWithLockRetry(
  payload: TurnContinuationRequest,
): Promise<void> {
  for (const [attempt, delayMs] of [
    ...TIMEOUT_RESUME_LOCK_RETRY_DELAYS_MS,
    undefined,
  ].entries()) {
    try {
      await resumeTimedOutTurn(payload);
      return;
    } catch (error) {
      if (!(error instanceof ResumeTurnBusyError)) {
        throw error;
      }
      if (typeof delayMs !== "number") {
        logWarn(
          "timeout_resume_lock_busy",
          {},
          {
            "app.ai.conversation_id": payload.conversationId,
            "app.ai.session_id": payload.sessionId,
            "app.ai.resume_lock_retry_count": attempt,
          },
          "Rescheduling timeout resume because another turn still owns the thread lock",
        );
        await scheduleTurnTimeoutResume(payload);
        return;
      }

      logWarn(
        "timeout_resume_lock_busy_retrying",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
          "app.ai.resume_lock_retry_attempt": attempt + 1,
          "app.ai.resume_lock_retry_delay_ms": delayMs,
        },
        "Timeout resume lock was busy; retrying",
      );
      await sleep(delayMs);
    }
  }
}

/** Handle the authenticated internal timeout-resume callback. */
export async function POST(
  request: Request,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const payload = await verifyTurnTimeoutResumeRequest(request);
  if (!payload) {
    return new Response("Unauthorized", { status: 401 });
  }

  waitUntil(() =>
    resumeTimedOutTurnWithLockRetry(payload).catch((error) => {
      logException(
        error,
        "timeout_resume_handler_failed",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
        },
        "Timeout resume handler failed",
      );
    }),
  );
  return new Response("Accepted", { status: 202 });
}
