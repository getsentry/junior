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
  withLogContext,
} from "@/chat/logging";
import {
  ResumeTurnBusyError,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  loadProjection,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  getAgentTurnSessionRecordForResume,
  listAgentTurnSessionSummariesForConversation,
  recordAgentTurnSessionSummary,
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
import {
  resolveTurnSessionRouting,
  type TurnSessionRouting,
} from "@/chat/services/turn-session-routing";
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
import type { AgentRunRouting } from "@/chat/agent/request";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import { requireSlackDestination } from "@/chat/destination";
import type { CredentialContext } from "@/chat/credentials/context";
import { sleep } from "@/chat/sleep";
import { modelIdForProfile } from "@/chat/model-profile";
import { latestReportedProgress } from "@/chat/runtime/report-progress";

const AGENT_CONTINUE_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

/** Runtime ports for agent continuation scheduling. */
export interface AgentContinueRunnerOptions {
  agentRunner: AgentRunner;
  /** Exact persisted input ids accepted for a non-interactive continuation. */
  inputMessageIds?: readonly string[];
  routingContext?: Pick<
    AgentRunRouting,
    | "actor"
    | "credentialContext"
    | "destinationVisibility"
    | "dispatch"
    | "surface"
  >;
  resumeTurn?: typeof resumeSlackTurn;
  scheduleAgentContinue?: (request: AgentContinueRequest) => Promise<void>;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
}

/** Per-worker controls for one continued run. */
export interface AgentContinueRunOptions {
  shouldYield?: () => boolean;
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
      "agent.continue.session_record.failure_persistence.failed",
      {
        "app.ai.conversation_id": args.sessionRecord.conversationId,
        "app.ai.session_id": args.sessionRecord.sessionId,
      },
    );
  }
}

/** Persist failed thread and session state after a continuation cannot finish. */
async function persistFailedReplyState(
  sessionRecord: AgentTurnSessionRecord,
  errorMessage = "Paused agent run failed while continuing",
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
    errorMessage,
  });
  await persistThreadStateById(sessionRecord.conversationId, {
    conversation,
  });
}

/** Convert startup failures into durable failed state before rethrowing. */
async function failContinuationStartup(args: {
  errorMessage: string;
  sessionRecord: AgentTurnSessionRecord;
}): Promise<void> {
  try {
    await persistFailedReplyState(args.sessionRecord, args.errorMessage);
  } catch (persistError) {
    await failSessionRecordBestEffort({
      sessionRecord: args.sessionRecord,
      errorMessage: "Paused agent run failed while preparing continuation",
    });
    logException(
      persistError,
      "agent.continue.startup_failure_persist.failed",
      {
        "app.ai.conversation_id": args.sessionRecord.conversationId,
        "app.ai.session_id": args.sessionRecord.sessionId,
      },
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
    (summary.resumeReason === "timeout" ||
      summary.resumeReason === "yield" ||
      summary.resumeReason === "retry")
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
  if (args.summary.dispatchId) {
    try {
      const routing = await resolveTurnSessionRouting({
        conversationId: args.conversationId,
      });
      await recordAgentTurnSessionSummary({
        actor: args.summary.actor,
        conversationId: args.conversationId,
        destination: routing.destination,
        dispatchId: args.summary.dispatchId,
        dispatchOutcome: "failed",
        sessionId: args.summary.sessionId,
        sliceId: args.summary.sliceId,
        source: routing.source,
        state: "failed",
        surface: args.summary.surface,
      });
    } catch (error) {
      logException(error, "agent.continue.dispatch_failure_summary.failed", {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.summary.sessionId,
      });
    }
  }
}

/**
 * Continue one paused Slack agent run from durable conversation state.
 *
 * Returns false when the session became stale before generation began.
 */
export async function continueSlackAgentRun(
  payload: AgentContinueRequest,
  options: AgentContinueRunnerOptions,
  runOptions: AgentContinueRunOptions = {},
): Promise<boolean> {
  return withLogContext({ conversationId: payload.conversationId }, () =>
    continueSlackAgentRunInContext(payload, options, runOptions),
  );
}

async function continueSlackAgentRunInContext(
  payload: AgentContinueRequest,
  options: AgentContinueRunnerOptions,
  runOptions: AgentContinueRunOptions,
): Promise<boolean> {
  const thread = parseSlackThreadId(payload.conversationId);
  const destination = requireSlackDestination(
    payload.destination,
    "Agent continuation",
  );
  const scheduleAgentContinue =
    options.scheduleAgentContinue ?? defaultScheduleAgentContinue;

  const resumeTurn = options.resumeTurn ?? resumeSlackTurn;
  return await resumeTurn({
    messageText: "",
    conversationId: payload.conversationId,
    turnId: payload.sessionId,
    channelId: thread?.channelId ?? destination.channelId,
    ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
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
            sessionRecord.resumeReason !== "yield" &&
            sessionRecord.resumeReason !== "retry") ||
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
        const dispatchId =
          activeSessionRecord.dispatchId ??
          options.routingContext?.dispatch?.id;
        const dispatchUserMessage = dispatchId
          ? conversation.messages.find(
              (message) =>
                message.role === "user" &&
                options.inputMessageIds?.includes(message.id),
            )
          : undefined;
        const userMessage =
          getTurnUserMessage(conversation, payload.sessionId) ??
          dispatchUserMessage;
        const systemActor =
          activeSessionRecord.actor?.platform === "system"
            ? activeSessionRecord.actor
            : undefined;
        const userActorId = userMessage?.author?.userId;
        if (!userMessage || (!systemActor && !userActorId)) {
          throw new Error(
            `Unable to locate the persisted user message for agent continuation session "${payload.sessionId}"`,
          );
        }
        if (conversation.processing.activeTurnId !== payload.sessionId) {
          return false;
        }

        const channelConfiguration = getChannelConfigurationServiceById(
          destination.channelId,
        );
        const conversationContext = dispatchId
          ? undefined
          : buildConversationContext(conversation, {
              excludeMessageId: userMessage.id,
            });
        const sandboxRef = getPersistedSandboxState(currentState);
        let actor: SlackActor | undefined;
        let credentialContext: CredentialContext;
        if (options.routingContext?.credentialContext) {
          credentialContext = options.routingContext.credentialContext;
        } else if (systemActor) {
          credentialContext = { actor: systemActor };
        } else {
          actor = await resolveContinuationActor({
            conversationId: payload.conversationId,
            sessionRecordActor: activeSessionRecord.actor,
            teamId: destination.teamId,
            userId: userActorId!,
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
        const routing = await resolveTurnSessionRouting({
          conversationId: payload.conversationId,
        });
        const source = routing.source;
        const routingDestination = routing.destination;

        const turnMessages =
          activeSessionRecord.turnStartMessageIndex === undefined
            ? []
            : activeSessionRecord.piMessages.slice(
                activeSessionRecord.turnStartMessageIndex,
              );
        const recordDispatchOutcome = async (
          dispatchOutcome: "blocked" | "failed",
        ): Promise<void> => {
          const dispatchId = options.routingContext?.dispatch?.id;
          if (!dispatchId) {
            return;
          }
          await recordAgentTurnSessionSummary({
            conversationId: payload.conversationId,
            destination: routingDestination,
            destinationVisibility:
              options.routingContext?.destinationVisibility,
            dispatchId,
            dispatchOutcome,
            sessionId: payload.sessionId,
            sliceId: activeSessionRecord.sliceId,
            source,
            state: "failed",
            surface: options.routingContext?.surface ?? "slack",
          });
        };

        return {
          messageText: userMessage.text,
          sliceId: activeSessionRecord.sliceId,
          messageTs: getTurnUserSlackMessageTs(userMessage),
          inputMessageIds: [userMessage.id],
          initialStatus: latestReportedProgress(turnMessages),
          replyContext: {
            input: {
              ...(conversationContext ? { conversationContext } : {}),
              // Pi history is SQL-authoritative: the resumed run reads its
              // exact dispatch session so unrelated conversation input cannot
              // gain system authority. Interactive turns retain their merged
              // projection so queued steering remains visible.
              piMessages: dispatchId
                ? activeSessionRecord.piMessages
                : await loadProjection({
                    conversationId: payload.conversationId,
                  }),
              ...getTurnUserReplyAttachmentContext(userMessage),
            },
            routing: {
              ...options.routingContext,
              credentialContext,
              ...((options.routingContext?.actor ?? actor)
                ? { actor: options.routingContext?.actor ?? actor }
                : {}),
              destination: routingDestination,
              source,
              toolChannelId:
                artifacts.assistantContextChannelId ?? destination.channelId,
            },
            policy: {
              channelConfiguration,
            },
            state: {
              artifactState: artifacts,
              pendingAuth: conversation.processing.pendingAuth,
              sandboxRef,
            },
            durability: {
              shouldYield: runOptions.shouldYield,
              recordPendingAuth: async (nextPendingAuth) => {
                conversation.processing.pendingAuth = nextPendingAuth;
                await persistThreadStateById(payload.conversationId, {
                  conversation,
                });
              },
            },
          },
          commitResult: async (reply: AgentRunResult) => {
            await persistCompletedReplyState({
              sessionRecord: activeSessionRecord,
              reply,
            });
          },
          onFailure: async (error) => {
            await persistFailedReplyState(
              activeSessionRecord,
              error instanceof Error ? error.message : String(error),
            );
            await recordDispatchOutcome("failed");
          },
          onPostDeliveryCommitFailure: async () => {
            await failAgentTurnSessionRecord({
              conversationId: activeSessionRecord.conversationId,
              expectedVersion: activeSessionRecord.version,
              sessionId: activeSessionRecord.sessionId,
              errorMessage:
                "Continued agent reply was delivered but completion state did not persist",
            });
            await recordDispatchOutcome("failed");
          },
          onAuthPause: async () => {
            await persistAuthPauseTurnState({
              sessionId: payload.sessionId,
              threadStateId: payload.conversationId,
            });
            await recordDispatchOutcome("blocked");
            logWarn("agent.continue.reparked_for_auth", {
              "app.ai.conversation_id": payload.conversationId,
              "app.ai.session_id": payload.sessionId,
            });
          },
          onSuspend: async (resumeVersion) => {
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
            errorMessage:
              error instanceof Error ? error.message : String(error),
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

  const eventName = "agent.turn.stranded_session.failed";
  const eventId = logException(new Error(args.errorMessage), eventName, {
    "app.ai.conversation_id": args.conversationId,
    "app.ai.session_id": args.sessionRecord.sessionId,
  });
  let routing: TurnSessionRouting;
  try {
    routing = await resolveTurnSessionRouting({
      conversationId: args.conversationId,
    });
  } catch (error) {
    logException(error, "agent.turn.stranded_session.routing_unavailable", {
      "app.ai.conversation_id": args.conversationId,
      "app.ai.session_id": args.sessionRecord.sessionId,
    });
    return;
  }
  if (args.sessionRecord.dispatchId) {
    await recordAgentTurnSessionSummary({
      actor: args.sessionRecord.actor,
      conversationId: args.conversationId,
      destination: routing.destination,
      dispatchId: args.sessionRecord.dispatchId,
      dispatchOutcome: "failed",
      sessionId: args.sessionRecord.sessionId,
      sliceId: args.sessionRecord.sliceId,
      source: routing.source,
      state: "failed",
      surface: args.sessionRecord.surface,
    });
  }
  const thread = parseSlackThreadId(args.conversationId);
  const channelId =
    thread?.channelId ??
    requireSlackDestination(routing.destination, "Stranded agent continuation")
      .channelId;
  await postSlackMessage({
    channelId,
    ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
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
  runOptions: AgentContinueRunOptions;
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

  const sessionRecord = await getAgentTurnSessionRecordForResume(
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

  let routing: TurnSessionRouting;
  try {
    routing = await resolveTurnSessionRouting({
      conversationId: args.conversationId,
    });
  } catch (error) {
    await failStrandedSessionWithFallback({
      conversationId: args.conversationId,
      errorMessage: error instanceof Error ? error.message : String(error),
      sessionRecord,
    });
    return false;
  }
  const parked = await persistYieldSessionRecord({
    channelName: sessionRecord.channelName,
    conversationId: args.conversationId,
    sessionId: sessionRecord.sessionId,
    currentSliceId: sessionRecord.sliceId,
    destination: routing.destination,
    source: routing.source,
    messages: sessionRecord.piMessages,
    errorMessage: "Recovered running session after hard worker death",
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

  if (
    await continueSlackAgentRunWithLockRetry(
      request,
      args.options,
      args.runOptions,
    )
  ) {
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
  runOptions: AgentContinueRunOptions = {},
): Promise<boolean> {
  return withLogContext({ conversationId }, () =>
    resumeAwaitingSlackContinuationInContext(
      conversationId,
      options,
      runOptions,
    ),
  );
}

async function resumeAwaitingSlackContinuationInContext(
  conversationId: string,
  options: AgentContinueRunnerOptions,
  runOptions: AgentContinueRunOptions,
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
      runOptions,
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

    if (
      await continueSlackAgentRunWithLockRetry(request, options, runOptions)
    ) {
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
  runOptions: AgentContinueRunOptions = {},
): Promise<boolean> {
  return withLogContext({ conversationId: payload.conversationId }, () =>
    continueSlackAgentRunWithLockRetryInContext(payload, options, runOptions),
  );
}

async function continueSlackAgentRunWithLockRetryInContext(
  payload: AgentContinueRequest,
  options: AgentContinueRunnerOptions,
  runOptions: AgentContinueRunOptions,
): Promise<boolean> {
  const scheduleAgentContinue =
    options.scheduleAgentContinue ?? defaultScheduleAgentContinue;
  for (const [attempt, delayMs] of [
    ...AGENT_CONTINUE_LOCK_RETRY_DELAYS_MS,
    undefined,
  ].entries()) {
    try {
      return await continueSlackAgentRun(payload, options, runOptions);
    } catch (error) {
      if (!(error instanceof ResumeTurnBusyError)) {
        throw error;
      }
      if (typeof delayMs !== "number") {
        logWarn("agent.continue.lock.busy", {
          "app.ai.conversation_id": payload.conversationId,
          "app.ai.session_id": payload.sessionId,
          "app.ai.resume_lock_retry_count": attempt,
        });
        await scheduleAgentContinue(payload);
        return true;
      }

      logWarn("agent.continue.lock.retrying", {
        "app.ai.conversation_id": payload.conversationId,
        "app.ai.session_id": payload.sessionId,
        "app.ai.resume_lock_retry_attempt": attempt + 1,
        "app.ai.resume_lock_retry_delay_ms": delayMs,
      });
      await sleep(delayMs);
    }
  }

  return true;
}
