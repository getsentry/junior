/**
 * Worker continue for paused turns under the conversation lease.
 *
 * Lives with mailbox + lease + checkpoint. Queue workers reach this through
 * app composition. Expected-version checks drop stale callbacks before
 * generation; started continues must durably record success, failure, auth
 * pause, or another safe pause boundary.
 */
import {
  buildTurnFailureResponse,
  logException,
  logWarn,
  withLogContext,
} from "@/chat/logging";
import { resumeSlackTurn } from "@/chat/runtime/slack-resume";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { loadProjection } from "@/chat/conversations/projection";
import {
  completeTurnRecord,
  failTurnRecord,
  getTurnRecord,
  getTurnRecordForResume,
  listTurnSummaries,
  recordTurnSummary,
  type TurnRecord,
  type TurnSummary,
} from "./turn-cursor";
import { loadTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import {
  getPersistedThreadState,
  getPersistedSandboxState,
  persistThreadStateById,
  getLocationConfigurationService,
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
  turnHasReply,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import {
  getPausedTurnRequest,
  wakePausedTurn as defaultWakePausedTurn,
  type PausedTurnRequest,
} from "@/chat/task-execution/turn-wake";
import {
  resolveTurnSessionRouting,
  type TurnSessionRouting,
} from "@/chat/services/turn-session-routing";
import { parseSlackThreadId } from "@/chat/slack/context";
import { postSlackMessage } from "@/chat/slack/outbound";
import { getStateAdapter } from "@/chat/state/adapter";
import { withActiveLock } from "@/chat/state/locks";
import { requireTurnFailureEventId } from "@/chat/services/turn-failure-response";
import {
  createSlackActor,
  createSlackResumeActor,
  type Actor,
  type SlackActor,
} from "@/chat/actor";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  isResourceEventConversationMessage,
  RESOURCE_EVENT_SYSTEM_ACTOR,
} from "@/chat/resource-events/actor";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRunRouting } from "@/chat/agent/request";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import { requireSlackDestination } from "@/chat/destination";
import {
  credentialContextForActor,
  type CredentialContext,
} from "@/chat/credentials/context";
import { latestReportedProgress } from "@/chat/runtime/report-progress";

/** Runtime ports for paused turn scheduling. */
export interface PausedTurnOptions {
  agentRunner: AgentRunner;
  /** Exact persisted input ids accepted while running the paused turn. */
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
  wakePausedTurn?: (request: PausedTurnRequest) => Promise<void>;
  scheduleSessionCompletedPluginTasks?: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
}

/** Per-worker controls for one paused turn. */
export interface PausedTurnRunOptions {
  shouldYield?: () => boolean;
}

/** Persist a delivered paused-turn reply as the terminal thread state. */
async function persistCompletedReplyState(args: {
  turn: TurnRecord;
  reply: AgentRunResult;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.turn.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.turn.conversationId,
  });
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, args.turn.turnId);
  const statePatch = buildDeliveredTurnStatePatch({
    artifacts,
    conversation,
    reply: args.reply,
    sessionId: args.turn.turnId,
    userMessageId: userMessage?.id,
  });

  await persistThreadStateById(args.turn.conversationId, {
    ...statePatch,
  });
}

/** Mark the run record failed without masking the original paused-turn error. */
async function failTurnBestEffort(args: {
  turn: TurnRecord;
  errorMessage: string;
}): Promise<void> {
  try {
    await failTurnRecord({
      conversationId: args.turn.conversationId,
      expectedVersion: args.turn.version,
      turnId: args.turn.turnId,
      errorMessage: args.errorMessage,
    });
  } catch (error) {
    logException(
      error,
      "agent.continue.session_record.failure_persistence.failed",
      {
        "app.ai.conversation_id": args.turn.conversationId,
        "app.ai.session_id": args.turn.turnId,
      },
    );
  }
}

/** Persist failed thread and turn state after a paused run cannot finish. */
async function persistFailedReplyState(
  turn: TurnRecord,
  errorMessage = "Paused agent run failed while continuing",
): Promise<void> {
  const currentState = await getPersistedThreadState(turn.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: turn.conversationId,
  });
  clearPendingAuth(conversation, turn.turnId);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: turn.turnId,
    userMessageId: getTurnUserMessage(conversation, turn.turnId)?.id,
    markConversationMessage,
  });

  await failTurnBestEffort({
    turn,
    errorMessage,
  });
  await persistThreadStateById(turn.conversationId, {
    conversation,
  });
}

/** Convert startup failures into durable failed state before rethrowing. */
async function failPausedTurnStart(args: {
  errorMessage: string;
  turn: TurnRecord;
}): Promise<void> {
  try {
    await persistFailedReplyState(args.turn, args.errorMessage);
  } catch (persistError) {
    await failTurnBestEffort({
      turn: args.turn,
      errorMessage: "Paused turn failed before it could run",
    });
    logException(
      persistError,
      "agent.continue.startup_failure_persist.failed",
      {
        "app.ai.conversation_id": args.turn.conversationId,
        "app.ai.session_id": args.turn.turnId,
      },
    );
  }
}

/**
 * Best-effort Slack user actor for resume.
 *
 * Never throws (issue #727). Prefer matching work-state profile data; always
 * fall back to bare author id + destination team when enrichment is missing
 * or unusable.
 */
async function resolveSlackResumeUserActor(args: {
  conversationId: string;
  teamId: string;
  userId: string;
}): Promise<SlackActor | undefined> {
  try {
    const work = await getConversationWorkState({
      conversationId: args.conversationId,
    });
    const workActor = work?.actor;
    if (
      workActor?.teamId === args.teamId &&
      workActor.slackUserId === args.userId
    ) {
      try {
        return createSlackActor(args.teamId, args.userId, {
          email: workActor.email,
          fullName: workActor.fullName,
          userName: workActor.slackUserName,
        });
      } catch {
        // Stored profile data is optional enrichment only.
      }
    }
  } catch {
    // Work-state is optional enrichment only.
  }

  try {
    return createSlackResumeActor({
      teamId: args.teamId,
      userId: args.userId,
    });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the run actor for a resumed turn, then derive credentialContext.
 *
 * Sources, in order:
 * 1. Caller routingContext (dispatch / OAuth already set actor + credentials)
 * 2. Resource-event markers → system actor
 * 3. Slack author + destination team
 *
 * Never reads Redis turn-session actor. Prefer setting actor first; credentials
 * come from the caller when already bound, else credentialContextForActor.
 */
async function resolveResumeExecutionIdentity(args: {
  conversationId: string;
  routingContext?: PausedTurnOptions["routingContext"];
  teamId: string;
  userMessage: {
    author?: { userId?: string };
    meta?: { eventType?: string };
  };
}): Promise<
  { actor: Actor; credentialContext: CredentialContext } | undefined
> {
  const routing = args.routingContext;

  // Dispatch / OAuth ports already own the full binding (including subject).
  if (routing?.credentialContext) {
    const actor =
      routing.dispatch?.actor ??
      routing.actor ??
      (!("type" in routing.credentialContext.actor)
        ? routing.credentialContext.actor
        : undefined);
    return actor
      ? { actor, credentialContext: routing.credentialContext }
      : undefined;
  }

  let actor: Actor | undefined = routing?.actor;
  if (!actor && isResourceEventConversationMessage(args.userMessage)) {
    actor = RESOURCE_EVENT_SYSTEM_ACTOR;
  }
  if (!actor && args.userMessage.author?.userId) {
    actor = await resolveSlackResumeUserActor({
      conversationId: args.conversationId,
      teamId: args.teamId,
      userId: args.userMessage.author.userId,
    });
  }
  if (!actor) {
    return undefined;
  }
  return {
    actor,
    credentialContext: credentialContextForActor(actor),
  };
}

function isPausedTurn(summary: TurnSummary): boolean {
  return (
    summary.state === "paused" &&
    (summary.resumeReason === "timeout" ||
      summary.resumeReason === "yield" ||
      summary.resumeReason === "retry")
  );
}

async function failPausedTurn(args: {
  conversationId: string;
  errorMessage: string;
  expectedVersion?: number;
  summary: TurnSummary;
}): Promise<void> {
  const failed = await failTurnRecord({
    conversationId: args.conversationId,
    expectedVersion: args.expectedVersion ?? args.summary.version,
    turnId: args.summary.turnId,
    errorMessage: args.errorMessage,
  });
  if (!failed) return;

  if (failed.dispatchId) {
    try {
      const routing = await resolveTurnSessionRouting({
        conversationId: args.conversationId,
      });
      await recordTurnSummary({
        conversationId: args.conversationId,
        destination: routing.destination,
        dispatchId: failed.dispatchId,
        dispatchOutcome: "failed",
        turnId: failed.turnId,
        sliceId: failed.sliceId,
        source: routing.source,
        state: "failed",
        surface: failed.surface,
      });
    } catch (error) {
      logException(error, "agent.continue.dispatch_failure_summary.failed", {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.summary.turnId,
      });
    }
  }
}

/**
 * Continue one paused Slack agent run from durable conversation state.
 *
 * Returns false when the session became stale before generation began.
 */
export async function runPausedTurn(
  payload: PausedTurnRequest,
  options: PausedTurnOptions,
  runOptions: PausedTurnRunOptions = {},
): Promise<boolean> {
  return withLogContext({ conversationId: payload.conversationId }, () =>
    runPausedTurnInContext(payload, options, runOptions),
  );
}

async function runPausedTurnInContext(
  payload: PausedTurnRequest,
  options: PausedTurnOptions,
  runOptions: PausedTurnRunOptions,
): Promise<boolean> {
  const thread = parseSlackThreadId(payload.conversationId);
  const destination = requireSlackDestination(
    payload.destination,
    "Paused turn",
  );
  const wakePausedTurn = options.wakePausedTurn ?? defaultWakePausedTurn;

  const resumeTurn = options.resumeTurn ?? resumeSlackTurn;
  return await resumeTurn({
    messageText: "",
    conversationId: payload.conversationId,
    turnId: payload.turnId,
    channelId: thread?.channelId ?? destination.channelId,
    ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
    lockKey: payload.conversationId,
    // Queue continue runs under the conversation work lease already.
    ownsConversationLease: true,
    agentRunner: options.agentRunner,
    scheduleSessionCompletedPluginTasks:
      options.scheduleSessionCompletedPluginTasks,
    beforeStart: async () => {
      let turn: TurnRecord | undefined;
      try {
        const checkpoint = await loadTurnCheckpoint({
          conversationId: payload.conversationId,
          turnId: payload.turnId,
        });
        turn = checkpoint.record;
        if (
          !turn ||
          turn.state !== "paused" ||
          (turn.resumeReason !== "timeout" &&
            turn.resumeReason !== "yield" &&
            turn.resumeReason !== "retry") ||
          turn.version !== payload.expectedVersion
        ) {
          return false;
        }
        const activeTurn = turn;

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
          activeTurn.dispatchId ?? options.routingContext?.dispatch?.id;
        const dispatchUserMessage = dispatchId
          ? conversation.messages.find(
              (message) =>
                message.role === "user" &&
                options.inputMessageIds?.includes(message.id),
            )
          : undefined;
        const userMessage =
          getTurnUserMessage(conversation, payload.turnId) ??
          dispatchUserMessage;
        if (!userMessage) {
          // Never throw out of beforeStart (issue #727); fail the session visibly.
          await failStrandedTurnWithFallback({
            conversationId: payload.conversationId,
            errorMessage: `Unable to locate the persisted user message for paused turn "${payload.turnId}"`,
            turn: activeTurn,
          });
          return false;
        }
        if (conversation.processing.activeTurnId !== payload.turnId) {
          return false;
        }

        const identity = await resolveResumeExecutionIdentity({
          conversationId: payload.conversationId,
          routingContext: options.routingContext,
          teamId: destination.teamId,
          userMessage,
        });
        if (!identity) {
          await failStrandedTurnWithFallback({
            conversationId: payload.conversationId,
            errorMessage:
              "Unable to rebuild the Slack actor for the paused turn",
            turn: activeTurn,
          });
          return false;
        }
        const { actor, credentialContext } = identity;

        const locationConfiguration =
          getLocationConfigurationService(destination);
        const conversationContext = dispatchId
          ? undefined
          : buildConversationContext(conversation, {
              excludeMessageId: userMessage.id,
            });
        const sandboxRef = getPersistedSandboxState(currentState);
        const routing = await resolveTurnSessionRouting({
          conversationId: payload.conversationId,
        });
        const source = routing.source;
        const routingDestination = routing.destination;

        const turnMessages =
          activeTurn.turnStartMessageIndex === undefined
            ? []
            : activeTurn.piMessages.slice(activeTurn.turnStartMessageIndex);
        const recordDispatchOutcome = async (
          dispatchOutcome: "blocked" | "failed",
        ): Promise<void> => {
          const dispatchId = options.routingContext?.dispatch?.id;
          if (!dispatchId) {
            return;
          }
          await recordTurnSummary({
            conversationId: payload.conversationId,
            destination: routingDestination,
            destinationVisibility:
              options.routingContext?.destinationVisibility,
            dispatchId,
            dispatchOutcome,
            turnId: payload.turnId,
            sliceId: activeTurn.sliceId,
            source,
            state: "failed",
            surface: options.routingContext?.surface ?? "slack",
          });
        };

        return {
          messageText: userMessage.text,
          sliceId: activeTurn.sliceId,
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
                ? activeTurn.piMessages
                : await loadProjection({
                    conversationId: payload.conversationId,
                  }),
              ...getTurnUserReplyAttachmentContext(userMessage),
            },
            routing: {
              ...options.routingContext,
              credentialContext,
              actor,
              destination: routingDestination,
              // Slack resume publishes unless the checkpoint opted out.
              // Missing means legacy/in-flight Slack turns still post.
              publishExternally: activeTurn.publishExternally !== false,
              source,
              toolChannelId:
                artifacts.assistantContextChannelId ?? destination.channelId,
            },
            policy: {
              locationConfiguration,
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
              turn: activeTurn,
              reply,
            });
          },
          onFailure: async (error) => {
            await persistFailedReplyState(
              activeTurn,
              error instanceof Error ? error.message : String(error),
            );
            await recordDispatchOutcome("failed");
          },
          onPostDeliveryCommitFailure: async () => {
            await failTurnRecord({
              conversationId: activeTurn.conversationId,
              expectedVersion: activeTurn.version,
              turnId: activeTurn.turnId,
              errorMessage:
                "Continued agent reply was delivered but completion state did not persist",
            });
            await recordDispatchOutcome("failed");
          },
          onAuthPause: async () => {
            await persistAuthPauseTurnState({
              sessionId: payload.turnId,
              threadStateId: payload.conversationId,
            });
            await recordDispatchOutcome("blocked");
            logWarn("agent.continue.reparked_for_auth", {
              "app.ai.conversation_id": payload.conversationId,
              "app.ai.session_id": payload.turnId,
            });
          },
          onSuspend: async (resumeVersion) => {
            await wakePausedTurn({
              conversationId: payload.conversationId,
              destination: payload.destination,
              turnId: payload.turnId,
              expectedVersion: resumeVersion,
            });
          },
        };
      } catch (error) {
        if (turn) {
          await failPausedTurnStart({
            errorMessage:
              error instanceof Error ? error.message : String(error),
            turn,
          });
        }
        throw error;
      }
    },
  });
}

/** Terminally fail a stranded turn and post the standard visible fallback. */
async function failStrandedTurnWithFallback(args: {
  conversationId: string;
  errorMessage: string;
  turn: TurnRecord;
}): Promise<boolean> {
  const failed = await failTurnRecord({
    conversationId: args.conversationId,
    expectedVersion: args.turn.version,
    turnId: args.turn.turnId,
    errorMessage: args.errorMessage,
  });
  if (!failed) return false;
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: failed.turnId,
    userMessageId: getTurnUserMessage(conversation, failed.turnId)?.id,
    markConversationMessage,
  });
  await persistThreadStateById(args.conversationId, { conversation });

  const eventName = "agent.turn.stranded_session.failed";
  const eventId = logException(new Error(args.errorMessage), eventName, {
    "app.ai.conversation_id": args.conversationId,
    "app.ai.session_id": failed.turnId,
  });
  let routing: TurnSessionRouting;
  try {
    routing = await resolveTurnSessionRouting({
      conversationId: args.conversationId,
    });
  } catch (error) {
    logException(error, "agent.turn.stranded_session.routing_unavailable", {
      "app.ai.conversation_id": args.conversationId,
      "app.ai.session_id": failed.turnId,
    });
    return true;
  }
  if (failed.dispatchId) {
    await recordTurnSummary({
      conversationId: args.conversationId,
      destination: routing.destination,
      dispatchId: failed.dispatchId,
      dispatchOutcome: "failed",
      turnId: failed.turnId,
      sliceId: failed.sliceId,
      source: routing.source,
      state: "failed",
      surface: failed.surface,
    });
  }
  const thread = parseSlackThreadId(args.conversationId);
  const channelId =
    thread?.channelId ??
    requireSlackDestination(routing.destination, "Stranded paused turn")
      .channelId;
  await postSlackMessage({
    channelId,
    ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
    text: buildTurnFailureResponse(
      requireTurnFailureEventId(eventId, eventName),
    ),
  });
  return true;
}

/** Resume the first valid paused Slack session for an idle conversation. */
export async function runNextPausedTurn(
  conversationId: string,
  options: PausedTurnOptions,
  runOptions: PausedTurnRunOptions = {},
): Promise<boolean> {
  return withLogContext({ conversationId }, () =>
    runNextPausedTurnInContext(conversationId, options, runOptions),
  );
}

async function runNextPausedTurnInContext(
  conversationId: string,
  options: PausedTurnOptions,
  runOptions: PausedTurnRunOptions,
): Promise<boolean> {
  const summaries = await listTurnSummaries(conversationId);
  const persisted = await getPersistedThreadState(conversationId);
  const conversation = coerceThreadConversationState(persisted);
  await hydrateConversationMessages({ conversation, conversationId });
  const newest = summaries[0];

  // SQL can already report completion while Redis still contains a running
  // cursor for the same turn. Inspect both before deciding recovery is done.
  const running = newest
    ? await getTurnRecord(conversationId, newest.turnId)
    : undefined;
  if (running?.state === "running") {
    if (turnHasReply(conversation, running.turnId)) {
      const acceptedReply = [...conversation.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.id.startsWith(`${running.turnId}:assistant:`),
        );
      const completed = await completeTurnRecord({
        conversationId,
        expectedVersion: running.version,
        resultMessageId: acceptedReply?.meta?.slackTs,
        turnId: running.turnId,
      });
      if (!completed) return false;
      markTurnCompleted({
        conversation,
        nowMs: Date.now(),
        sessionId: running.turnId,
      });
      await persistThreadStateById(conversationId, { conversation });
      return false;
    }

    const state = getStateAdapter();
    await state.connect();
    await withActiveLock(state, conversationId, async () => {
      const record = await getTurnRecordForResume(
        conversationId,
        running.turnId,
      );
      if (!record || record.state !== "running") return;
      await failStrandedTurnWithFallback({
        conversationId,
        errorMessage: "Turn lost its worker before reaching a safe boundary",
        turn: record,
      });
    });
    return false;
  }

  for (const summary of summaries) {
    if (!isPausedTurn(summary)) {
      continue;
    }

    const request = await getPausedTurnRequest({
      conversationId,
      turnId: summary.turnId,
    });
    if (!request) {
      await failPausedTurn({
        conversationId,
        summary,
        errorMessage: "Awaiting paused-turn metadata could not be materialized",
      });
      continue;
    }

    if (await runPausedTurn(request, options, runOptions)) {
      return true;
    }

    await failPausedTurn({
      conversationId,
      expectedVersion: request.expectedVersion,
      summary,
      errorMessage: "Awaiting paused turn was stale before it could run",
    });
  }

  return false;
}
