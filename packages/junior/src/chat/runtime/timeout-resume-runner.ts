import { logException, logWarn } from "@/chat/logging";
import {
  ResumeTurnBusyError,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  type AgentTurnSessionRecord,
} from "@/chat/state/turn-session";
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
  scheduleTurnTimeoutResume as defaultScheduleTurnTimeoutResume,
  type TurnContinuationRequest,
} from "@/chat/services/timeout-resume";
import { parseSlackThreadId } from "@/chat/slack/context";
import { lookupSlackActorIdentity } from "@/chat/slack/user";
import type { AssistantReply } from "@/chat/respond";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
} from "@/chat/services/pending-auth";

const TIMEOUT_RESUME_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

/** Runtime ports for timeout continuation scheduling. */
export interface TimeoutResumeRunnerOptions {
  scheduleTurnTimeoutResume?: (
    request: TurnContinuationRequest,
  ) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistCompletedReplyState(args: {
  sessionRecord: AgentTurnSessionRecord;
  reply: AssistantReply;
}): Promise<void> {
  const currentState = await getPersistedThreadState(
    args.sessionRecord.conversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(
    conversation,
    args.sessionRecord.sessionId,
  );
  const statePatch = buildDeliveredTurnStatePatch({
    artifacts,
    conversation,
    reply: args.reply,
    sessionId: args.sessionRecord.sessionId,
    userMessageId: userMessage?.id,
  });

  await persistThreadStateById(args.sessionRecord.conversationId, {
    ...statePatch,
  });
}

async function failSessionRecordBestEffort(args: {
  sessionRecord: AgentTurnSessionRecord;
  errorMessage: string;
}): Promise<void> {
  try {
    await failAgentTurnSessionRecord({
      conversationId: args.sessionRecord.conversationId,
      expectedVersion: args.sessionRecord.version,
      sessionId: args.sessionRecord.sessionId,
      errorMessage: args.errorMessage,
    });
  } catch (error) {
    logException(
      error,
      "timeout_resume_session_record_fail_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.sessionRecord.conversationId,
        "app.ai.session_id": args.sessionRecord.sessionId,
      },
      "Failed to mark timed-out turn session record failed",
    );
  }
}

async function persistFailedReplyState(
  sessionRecord: AgentTurnSessionRecord,
): Promise<void> {
  const currentState = await getPersistedThreadState(
    sessionRecord.conversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  clearPendingAuth(conversation, sessionRecord.sessionId);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: sessionRecord.sessionId,
    userMessageId: getTurnUserMessage(conversation, sessionRecord.sessionId)
      ?.id,
    markConversationMessage,
    updateConversationStats,
  });

  await failSessionRecordBestEffort({
    sessionRecord,
    errorMessage: "Timed-out turn failed while resuming",
  });
  await persistThreadStateById(sessionRecord.conversationId, {
    conversation,
  });
}

/**
 * Resume one durable timeout continuation for a Slack thread.
 *
 * Returns false when the session became stale before generation began.
 */
export async function resumeTimedOutTurn(
  payload: TurnContinuationRequest,
  options: TimeoutResumeRunnerOptions = {},
): Promise<boolean> {
  const thread = parseSlackThreadId(payload.conversationId);
  if (!thread) {
    throw new Error(
      `Timeout resume requires a Slack thread conversation id, got "${payload.conversationId}"`,
    );
  }
  const scheduleTurnTimeoutResume =
    options.scheduleTurnTimeoutResume ?? defaultScheduleTurnTimeoutResume;

  return await resumeSlackTurn({
    messageText: "",
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    lockKey: payload.conversationId,
    beforeStart: async () => {
      const sessionRecord = await getAgentTurnSessionRecord(
        payload.conversationId,
        payload.sessionId,
      );
      if (
        !sessionRecord ||
        sessionRecord.state !== "awaiting_resume" ||
        (sessionRecord.resumeReason !== "timeout" &&
          sessionRecord.resumeReason !== "yield") ||
        sessionRecord.version !== payload.expectedVersion
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
      const requester = await lookupSlackActorIdentity(
        userMessage.author.userId,
      );

      return {
        messageText: userMessage.text,
        messageTs: getTurnUserSlackMessageTs(userMessage),
        replyContext: {
          credentialContext: {
            actor: {
              type: "user",
              userId: userMessage.author.userId,
            },
          },
          requester,
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
          await persistCompletedReplyState({ sessionRecord, reply });
        },
        onFailure: async () => {
          await persistFailedReplyState(sessionRecord);
        },
        onPostDeliveryCommitFailure: async () => {
          await failAgentTurnSessionRecord({
            conversationId: sessionRecord.conversationId,
            expectedVersion: sessionRecord.version,
            sessionId: sessionRecord.sessionId,
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
          const version = error.metadata?.version;
          if (typeof version !== "number") {
            throw new Error(
              "Timed-out resume turn did not include a turn-session version",
            );
          }

          await scheduleTurnTimeoutResume({
            conversationId: payload.conversationId,
            sessionId: payload.sessionId,
            expectedVersion: version,
          });
        },
      };
    },
  });
}

/**
 * Retry timeout continuation when the normal Slack thread lock is briefly busy.
 *
 * Returns false when the session became stale before generation began. A busy
 * lock that is rescheduled still returns true because runnable work remains
 * durable.
 */
export async function resumeTimedOutTurnWithLockRetry(
  payload: TurnContinuationRequest,
  options: TimeoutResumeRunnerOptions = {},
): Promise<boolean> {
  const scheduleTurnTimeoutResume =
    options.scheduleTurnTimeoutResume ?? defaultScheduleTurnTimeoutResume;
  for (const [attempt, delayMs] of [
    ...TIMEOUT_RESUME_LOCK_RETRY_DELAYS_MS,
    undefined,
  ].entries()) {
    try {
      return await resumeTimedOutTurn(payload, options);
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
        return true;
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

  return true;
}
