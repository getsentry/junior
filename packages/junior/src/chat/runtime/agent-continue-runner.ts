/**
 * Slack-only continuation runner for paused agent sessions.
 *
 * Queue workers reach this through app composition. Expected-version checks
 * drop stale callbacks before generation, while any started continuation must
 * durably record success, failure, auth pause, or another safe pause boundary.
 */
import { botConfig } from "@/chat/config";
import {
  buildTurnFailureResponse,
  logException,
  logWarn,
} from "@/chat/logging";
import {
  ResumeTurnBusyError,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";
import {
  loadProjection,
  loadConversationProjection,
} from "@/chat/conversations/projection";
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
import { markTurnFailed } from "@/chat/runtime/turn";
import {
  getAwaitingAgentContinueRequest,
  scheduleAgentContinue as defaultScheduleAgentContinue,
  type AgentContinueRequest,
} from "@/chat/services/agent-continue";
import { parseSlackThreadId } from "@/chat/slack/context";
import { postSlackMessage } from "@/chat/slack/outbound";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { persistYieldSessionRecord } from "@/chat/services/turn-session-record";
import { requireTurnFailureEventId } from "@/chat/services/turn-failure-response";
import {
  createSlackActor,
  createSlackResumeActor,
  type Actor,
  type SlackActor,
} from "@/chat/actor";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import { requireSlackDestination } from "@/chat/destination";
import type { CredentialContext } from "@/chat/credentials/context";
import { sleep } from "@/chat/sleep";
import {
  modelIdForProfile,
  STANDARD_MODEL_PROFILE,
} from "@/chat/model-profile";
import {
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { latestReportedProgress } from "@/chat/runtime/report-progress";

const AGENT_CONTINUE_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

/** Runtime ports for agent continuation scheduling. */
export interface AgentContinueRunnerOptions {
  agentRunner: AgentRunner;
  resumeTurn?: typeof resumeSlackTurn;
  scheduleAgentContinue?: (request: AgentContinueRequest) => Promise<void>;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
}

/** Persist a delivered continuation reply as the terminal thread state. */
async function persistCompletedReplyState(args: {
  sessionRecord: AgentTurnSessionRecord;
  reply: AgentRunResult;
}): Promise<void> {
  const currentState = await getPersistedThreadState(
    args.sessionRecord.conversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.sessionRecord.conversationId,
  });
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
  await hydrateConversationMessages({
    conversation,
    conversationId: sessionRecord.conversationId,
  });
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

/**
 * Resolve the resume actor without ever throwing for missing identity.
 *
 * A throw escaping `beforeStart` NACKs the continue queue delivery and
 * permanently wedges the conversation (issue #727), so identity gaps must
 * resolve to `undefined` and let the caller fail the session visibly. When
 * the session record lacks a usable actor, recovery consults the durable
 * conversation work record — but only an identity that matches the resume
 * actor (team + user) is ever rebuilt; we never fabricate one.
 */
async function resolveContinuationActor(args: {
  conversationId: string;
  sessionRecordActor: Actor | undefined;
  teamId: string;
  userId: string;
}): Promise<SlackActor | undefined> {
  const stored = args.sessionRecordActor;
  if (
    stored?.platform === "slack" &&
    stored.teamId === args.teamId &&
    stored.userId === args.userId
  ) {
    return createSlackResumeActor({
      actor: stored,
      teamId: args.teamId,
      userId: args.userId,
    });
  }

  const work = await getConversationWorkState({
    conversationId: args.conversationId,
  });
  const workActor = work?.actor;
  if (
    workActor &&
    workActor.teamId === args.teamId &&
    workActor.slackUserId === args.userId
  ) {
    return createSlackActor(args.teamId, args.userId, {
      email: workActor.email,
      fullName: workActor.fullName,
      userName: workActor.slackUserName,
    });
  }

  return undefined;
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
  options: AgentContinueRunnerOptions,
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
    agentRunner: options.agentRunner,
    scheduleSessionCompletedPluginTasks:
      options.scheduleSessionCompletedPluginTasks,
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
        await hydrateConversationMessages({
          conversation,
          conversationId: payload.conversationId,
        });
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
        const destination = requireSlackDestination(
          payload.destination,
          "Slack continuation",
        );
        const systemActor =
          activeSessionRecord.actor?.platform === "system"
            ? activeSessionRecord.actor
            : undefined;
        let actor: SlackActor | undefined;
        let credentialContext: CredentialContext;
        if (systemActor) {
          credentialContext = { actor: systemActor };
        } else {
          actor = await resolveContinuationActor({
            conversationId: payload.conversationId,
            sessionRecordActor: activeSessionRecord.actor,
            teamId: destination.teamId,
            userId: userMessage.author.userId,
          });
          if (!actor) {
            await failStrandedSessionWithFallback({
              conversationId: payload.conversationId,
              errorMessage: "Stored Slack actor missing for continuation",
              sessionRecord: activeSessionRecord,
            });
            return false;
          }
          credentialContext = {
            actor: {
              type: "user",
              userId: actor.userId,
            },
          };
        }
        if (!activeSessionRecord.source) {
          await failAgentTurnSessionRecord({
            conversationId: payload.conversationId,
            expectedVersion: activeSessionRecord.version,
            sessionId: payload.sessionId,
            errorMessage: "Stored Slack source missing for continuation",
          });
          return false;
        }

        const turnMessages =
          activeSessionRecord.turnStartMessageIndex === undefined
            ? []
            : activeSessionRecord.piMessages.slice(
                activeSessionRecord.turnStartMessageIndex,
              );

        return {
          messageText: userMessage.text,
          messageTs: getTurnUserSlackMessageTs(userMessage),
          initialStatus: latestReportedProgress(turnMessages),
          replyContext: {
            input: {
              conversationContext,
              // Pi history is SQL-authoritative: the resumed run reads its
              // session record first and falls back to the step projection.
              piMessages: await loadProjection({
                conversationId: payload.conversationId,
              }),
              ...getTurnUserReplyAttachmentContext(userMessage),
            },
            routing: {
              credentialContext,
              ...(actor ? { actor } : {}),
              destination: payload.destination,
              source: activeSessionRecord.source,
              correlation: {
                conversationId: payload.conversationId,
                turnId: payload.sessionId,
                channelId: thread.channelId,
                threadTs: thread.threadTs,
                ...(actor ? { actorId: actor.userId } : {}),
              },
              toolChannelId:
                artifacts.assistantContextChannelId ?? thread.channelId,
            },
            policy: {
              channelConfiguration,
            },
            state: {
              artifactState: artifacts,
              pendingAuth: conversation.processing.pendingAuth,
              sandbox,
            },
            durability: {
              recordPendingAuth: async (nextPendingAuth) => {
                conversation.processing.pendingAuth = nextPendingAuth;
                await persistThreadStateById(payload.conversationId, {
                  conversation,
                });
              },
            },
          },
          onSuccess: async (reply: AgentRunResult) => {
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
          onTimeoutPause: async ({ resumeVersion }) => {
            await scheduleAgentContinue({
              conversationId: payload.conversationId,
              destination: payload.destination,
              sessionId: payload.sessionId,
              expectedVersion: resumeVersion,
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

/** Terminally fail a stranded session and post the standard visible fallback. */
async function failStrandedSessionWithFallback(args: {
  conversationId: string;
  errorMessage: string;
  sessionRecord: AgentTurnSessionRecord;
}): Promise<void> {
  await failAgentTurnSessionRecord({
    conversationId: args.conversationId,
    expectedVersion: args.sessionRecord.version,
    sessionId: args.sessionRecord.sessionId,
    errorMessage: args.errorMessage,
  });
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionRecord.sessionId,
    userMessageId: getTurnUserMessage(
      conversation,
      args.sessionRecord.sessionId,
    )?.id,
    markConversationMessage,
    updateConversationStats,
  });
  await persistThreadStateById(args.conversationId, { conversation });

  const thread = parseSlackThreadId(args.conversationId);
  if (!thread) {
    return;
  }
  const eventName = "agent_turn_stranded_session_failed";
  const eventId = logException(
    new Error(args.errorMessage),
    eventName,
    { conversationId: args.conversationId },
    {
      "app.ai.conversation_id": args.conversationId,
      "app.ai.session_id": args.sessionRecord.sessionId,
    },
    "Stranded running agent session terminally failed",
  );
  await postSlackMessage({
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    text: buildTurnFailureResponse(
      requireTurnFailureEventId(eventId, eventName),
    ),
  });
}

/**
 * Recover a conversation whose newest session is still `running` with no live
 * owner (hard worker death mid-slice). The session is re-parked at its latest
 * durable safe boundary and continued; when no resumable boundary remains it
 * is terminally failed with the standard visible fallback so the interrupted
 * request never dies silently.
 */
async function recoverStrandedRunningSession(args: {
  conversationId: string;
  options: AgentContinueRunnerOptions;
  summary: AgentTurnSessionSummary;
}): Promise<boolean> {
  // A live resume outside the mailbox lease (OAuth/timeout continuation)
  // holds the thread resume lock for its whole run; only a dead slice leaves
  // a running record unlocked.
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const probe = await acquireActiveLock(stateAdapter, args.conversationId);
  if (!probe) {
    return false;
  }
  await stateAdapter.releaseLock(probe);

  const sessionRecord = await getAgentTurnSessionRecord(
    args.conversationId,
    args.summary.sessionId,
  );
  if (!sessionRecord || sessionRecord.state !== "running") {
    return false;
  }

  const recoveryProjection = await loadConversationProjection({
    conversationId: args.conversationId,
  });
  const modelProfile = recoveryProjection.modelProfile;
  const modelId = modelIdForProfile(botConfig, modelProfile);
  const recoveryMessages =
    modelProfile !== STANDARD_MODEL_PROFILE
      ? [
          ...stripRuntimeTurnContext(recoveryProjection.messages),
          ...retainRuntimeTurnContext(sessionRecord.piMessages),
        ]
      : sessionRecord.piMessages;

  const parked = await persistYieldSessionRecord({
    channelName: sessionRecord.channelName,
    conversationId: args.conversationId,
    sessionId: sessionRecord.sessionId,
    currentSliceId: sessionRecord.sliceId,
    destination: sessionRecord.destination,
    source: sessionRecord.source,
    messages: recoveryMessages,
    errorMessage: "Recovered running session after hard worker death",
    logContext: {},
    modelId,
    actor: sessionRecord.actor,
    surface: sessionRecord.surface,
  });
  if (!parked) {
    await failStrandedSessionWithFallback({
      conversationId: args.conversationId,
      errorMessage:
        "Stranded running session had no resumable boundary after worker death",
      sessionRecord,
    });
    return false;
  }

  const request = await getAwaitingAgentContinueRequest({
    conversationId: args.conversationId,
    sessionId: sessionRecord.sessionId,
  });
  if (!request) {
    await failStrandedSessionWithFallback({
      conversationId: args.conversationId,
      errorMessage:
        "Stranded running session could not materialize continuation metadata",
      sessionRecord: parked,
    });
    return false;
  }

  if (await continueSlackAgentRunWithLockRetry(request, args.options)) {
    return true;
  }
  await failUnresumableContinuation({
    conversationId: args.conversationId,
    expectedVersion: request.expectedVersion,
    summary: args.summary,
    errorMessage: "Awaiting agent continuation was stale before it could run",
  });
  return false;
}

/** Resume the first valid paused Slack session for an idle conversation. */
export async function resumeAwaitingSlackContinuation(
  conversationId: string,
  options: AgentContinueRunnerOptions,
): Promise<boolean> {
  const summaries =
    await listAgentTurnSessionSummariesForConversation(conversationId);

  // Recovery must cover every non-terminal session: a newest `running` record
  // under the (already re-acquired) conversation lease means the previous
  // worker died mid-slice without persisting a pause boundary.
  const newest = summaries[0];
  if (newest?.state === "running") {
    return await recoverStrandedRunningSession({
      conversationId,
      options,
      summary: newest,
    });
  }

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

    if (await continueSlackAgentRunWithLockRetry(request, options)) {
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
  options: AgentContinueRunnerOptions,
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
