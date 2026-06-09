/**
 * Slack-only continuation runner for paused agent sessions.
 *
 * Queue workers reach this through app composition. Expected-version checks
 * drop stale callbacks before generation, while any started continuation must
 * durably record success, failure, auth pause, or another safe pause boundary.
 */
import { logException, logWarn } from "@/chat/logging";
import {
  ResumeTurnBusyError,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  listAgentTurnSessionSummariesForConversation,
  type AgentTurnSessionRecord,
  type AgentTurnSessionSummary,
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
  getAwaitingAgentContinueRequest,
  scheduleAgentContinue as defaultScheduleAgentContinue,
  type AgentContinueRequest,
} from "@/chat/services/agent-continue";
import { parseSlackThreadId } from "@/chat/slack/context";
import { createRequesterFromStoredSlackRequester } from "@/chat/requester";
import type { AssistantReply, generateAssistantReply } from "@/chat/respond";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
} from "@/chat/services/pending-auth";

const AGENT_CONTINUE_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

/** Runtime ports for agent continuation scheduling. */
export interface AgentContinueRunnerOptions {
  generateReply?: typeof generateAssistantReply;
  resumeTurn?: typeof resumeSlackTurn;
  scheduleAgentContinue?: (request: AgentContinueRequest) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persist a delivered continuation reply as the terminal thread state. */
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

/** Mark the run record failed without masking the original continuation error. */
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
      "agent_continue_session_record_fail_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.sessionRecord.conversationId,
        "app.ai.session_id": args.sessionRecord.sessionId,
      },
      "Failed to mark paused agent run session record failed",
    );
  }
}

/** Persist failed thread and session state after a continuation cannot finish. */
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
    errorMessage: "Paused agent run failed while continuing",
  });
  await persistThreadStateById(sessionRecord.conversationId, {
    conversation,
  });
}

/** Convert startup failures into durable failed state before rethrowing. */
async function failContinuationStartup(args: {
  sessionRecord: AgentTurnSessionRecord;
}): Promise<void> {
  try {
    await persistFailedReplyState(args.sessionRecord);
  } catch (persistError) {
    await failSessionRecordBestEffort({
      sessionRecord: args.sessionRecord,
      errorMessage: "Paused agent run failed while preparing continuation",
    });
    logException(
      persistError,
      "agent_continue_startup_failure_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.sessionRecord.conversationId,
        "app.ai.session_id": args.sessionRecord.sessionId,
      },
      "Failed to persist paused agent run startup failure",
    );
  }
}

function isContinuationResume(summary: AgentTurnSessionSummary): boolean {
  return (
    summary.state === "awaiting_resume" &&
    (summary.resumeReason === "timeout" || summary.resumeReason === "yield")
  );
}

async function failUnresumableContinuation(args: {
  conversationId: string;
  errorMessage: string;
  expectedVersion?: number;
  summary: AgentTurnSessionSummary;
}): Promise<void> {
  await failAgentTurnSessionRecord({
    conversationId: args.conversationId,
    expectedVersion: args.expectedVersion ?? args.summary.version,
    sessionId: args.summary.sessionId,
    errorMessage: args.errorMessage,
  });
}

/**
 * Continue one paused Slack agent run from durable conversation state.
 *
 * Returns false when the session became stale before generation began.
 */
export async function continueSlackAgentRun(
  payload: AgentContinueRequest,
  options: AgentContinueRunnerOptions = {},
): Promise<boolean> {
  const thread = parseSlackThreadId(payload.conversationId);
  if (!thread) {
    throw new Error(
      `Agent continuation requires a Slack thread conversation id, got "${payload.conversationId}"`,
    );
  }
  const scheduleAgentContinue =
    options.scheduleAgentContinue ?? defaultScheduleAgentContinue;

  const resumeTurn = options.resumeTurn ?? resumeSlackTurn;
  return await resumeTurn({
    messageText: "",
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    lockKey: payload.conversationId,
    generateReply: options.generateReply,
    beforeStart: async () => {
      let sessionRecord: AgentTurnSessionRecord | undefined;
      try {
        sessionRecord = await getAgentTurnSessionRecord(
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
        const activeSessionRecord = sessionRecord;

        const currentState = await getPersistedThreadState(
          payload.conversationId,
        );
        const conversation = coerceThreadConversationState(currentState);
        const artifacts = coerceThreadArtifactsState(currentState);
        const userMessage = getTurnUserMessage(conversation, payload.sessionId);
        if (!userMessage?.author?.userId) {
          throw new Error(
            `Unable to locate the persisted user message for agent continuation session "${payload.sessionId}"`,
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
        const requester = createRequesterFromStoredSlackRequester({
          requester: activeSessionRecord.requester,
          teamId: payload.destination.teamId,
          userId: userMessage.author.userId,
        });

        return {
          messageText: userMessage.text,
          messageTs: getTurnUserSlackMessageTs(userMessage),
          replyContext: {
            credentialContext: {
              actor: {
                type: "user",
                userId: requester.userId,
              },
            },
            requester,
            destination: payload.destination,
            correlation: {
              conversationId: payload.conversationId,
              turnId: payload.sessionId,
              channelId: thread.channelId,
              threadTs: thread.threadTs,
              requesterId: requester.userId,
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
            await persistCompletedReplyState({
              sessionRecord: activeSessionRecord,
              reply,
            });
          },
          onFailure: async () => {
            await persistFailedReplyState(activeSessionRecord);
          },
          onPostDeliveryCommitFailure: async () => {
            await failAgentTurnSessionRecord({
              conversationId: activeSessionRecord.conversationId,
              expectedVersion: activeSessionRecord.version,
              sessionId: activeSessionRecord.sessionId,
              errorMessage:
                "Continued agent reply was delivered but completion state did not persist",
            });
          },
          onAuthPause: async () => {
            await persistAuthPauseTurnState({
              sessionId: payload.sessionId,
              threadStateId: payload.conversationId,
            });
            logWarn(
              "agent_continue_reparked_for_auth",
              {},
              {
                "app.ai.conversation_id": payload.conversationId,
                "app.ai.session_id": payload.sessionId,
              },
              "Continued agent run parked for auth",
            );
          },
          onTimeoutPause: async (error: unknown) => {
            if (!isRetryableTurnError(error, "agent_continue")) {
              throw error;
            }
            const version = error.metadata?.version;
            if (typeof version !== "number") {
              throw new Error(
                "Agent continuation did not include a session record version",
              );
            }

            await scheduleAgentContinue({
              conversationId: payload.conversationId,
              destination: payload.destination,
              sessionId: payload.sessionId,
              expectedVersion: version,
            });
          },
        };
      } catch (error) {
        if (sessionRecord) {
          await failContinuationStartup({
            sessionRecord,
          });
        }
        throw error;
      }
    },
  });
}

/** Resume the first valid paused Slack session for an idle conversation. */
export async function resumeAwaitingSlackContinuation(
  conversationId: string,
): Promise<boolean> {
  const summaries =
    await listAgentTurnSessionSummariesForConversation(conversationId);

  for (const summary of summaries) {
    if (!isContinuationResume(summary)) {
      continue;
    }

    const request = await getAwaitingAgentContinueRequest({
      conversationId,
      sessionId: summary.sessionId,
    });
    if (!request) {
      await failUnresumableContinuation({
        conversationId,
        summary,
        errorMessage:
          "Awaiting agent continuation metadata could not be materialized",
      });
      continue;
    }

    if (await continueSlackAgentRunWithLockRetry(request)) {
      return true;
    }

    await failUnresumableContinuation({
      conversationId,
      expectedVersion: request.expectedVersion,
      summary,
      errorMessage: "Awaiting agent continuation was stale before it could run",
    });
  }

  return false;
}

/**
 * Retry agent continuation when the normal Slack thread lock is briefly busy.
 *
 * Returns false when the session became stale before generation began. A busy
 * lock that is rescheduled still returns true because runnable work remains
 * durable.
 */
export async function continueSlackAgentRunWithLockRetry(
  payload: AgentContinueRequest,
  options: AgentContinueRunnerOptions = {},
): Promise<boolean> {
  const scheduleAgentContinue =
    options.scheduleAgentContinue ?? defaultScheduleAgentContinue;
  for (const [attempt, delayMs] of [
    ...AGENT_CONTINUE_LOCK_RETRY_DELAYS_MS,
    undefined,
  ].entries()) {
    try {
      return await continueSlackAgentRun(payload, options);
    } catch (error) {
      if (!(error instanceof ResumeTurnBusyError)) {
        throw error;
      }
      if (typeof delayMs !== "number") {
        logWarn(
          "agent_continue_lock_busy",
          {},
          {
            "app.ai.conversation_id": payload.conversationId,
            "app.ai.session_id": payload.sessionId,
            "app.ai.resume_lock_retry_count": attempt,
          },
          "Rescheduling agent continuation because another run still owns the thread lock",
        );
        await scheduleAgentContinue(payload);
        return true;
      }

      logWarn(
        "agent_continue_lock_busy_retrying",
        {},
        {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
          "app.ai.resume_lock_retry_attempt": attempt + 1,
          "app.ai.resume_lock_retry_delay_ms": delayMs,
        },
        "Agent continuation lock was busy; retrying",
      );
      await sleep(delayMs);
    }
  }

  return true;
}
