/** Run a mailbox Turn and store its assistant Messages. */
import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createWebAuthorization,
  deleteWebAuthorization,
} from "@/chat/conversations/web-authorization";
import { loadProjection } from "@/chat/conversations/projection";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  commitAssistantMessage,
  type DeliverMessage,
  type DeliveryResult,
} from "@/chat/task-execution/assistant-message";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { logException, setTags, withLogContext } from "@/chat/logging";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { AgentRunError, executeTurn } from "@/chat/runtime/turn-execution";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  markTurnClosed,
  markTurnFailed,
  startActiveTurn,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { botConfig } from "@/chat/config";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { recordFinishedTurnForAutomatedLimit } from "@/chat/services/automated-turn-limit";
import { maybePostAutomatedTurnLimitNotice } from "@/chat/services/automated-turn-limit-notice";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  abandonTurnRecord,
  getTurnRecord,
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  sourceFromTurnInput,
  turnInputFactsFromConversationMessage,
  type MailboxTurnWork,
  type TurnInputFacts,
} from "@/chat/task-execution/mailbox-turn";
import { joinMailboxText } from "@/chat/task-execution/mailbox-input";
import { resolveConversationDestination } from "@/chat/conversations/destination";
import { isResourceEventConversationMessage } from "@/chat/resource-events/actor";

function stableHex(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function captureConversationTurnFailure(args: {
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  runId?: string;
  turnId: string;
}): string | undefined {
  const eventId = logException(
    args.error,
    `conversation.turn.${args.failureCode}`,
    {
      conversationId: args.conversationId,
      ...(args.runId ? { runId: args.runId } : undefined),
      turnId: args.turnId,
    },
  );
  return typeof eventId === "string" ? eventId : undefined;
}

function hasLostTurnInputCommit(error: unknown): boolean {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return isTurnInputCommitLostError(error) || isTurnInputCommitLostError(cause);
}

async function completeCancelledConversationTurn(args: {
  acknowledge(): Promise<void>;
  conversation: ThreadConversationState;
  conversationId: string;
  sandboxRef?: SandboxRef;
  turnId: string;
  userMessageId: string;
}): Promise<void> {
  const pendingAuthorization =
    args.conversation.processing.pendingAuth?.sessionId === args.turnId
      ? args.conversation.processing.pendingAuth
      : undefined;
  await abandonTurnRecord({
    conversationId: args.conversationId,
    turnId: args.turnId,
    errorMessage: "Turn cancelled",
  });
  clearPendingAuth(args.conversation, args.turnId);
  markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "turn cancelled",
  });
  markTurnClosed({
    conversation: args.conversation,
    nowMs: Date.now(),
    sessionId: args.turnId,
  });
  if (pendingAuthorization) {
    await deleteWebAuthorization({
      actorId: pendingAuthorization.actorId,
      conversationId: args.conversationId,
    });
  }
  await persistThreadStateById(args.conversationId, {
    conversation: args.conversation,
    sandboxRef: args.sandboxRef,
  });
  await new ConversationTurnLifecycleService(
    getConversationEventStore(),
  ).complete({
    conversationId: args.conversationId,
    createdAtMs: Date.now(),
    outcome: "cancelled",
    turnId: args.turnId,
  });
  await args.acknowledge();
}

/**
 * Create the shared mailbox worker for web and resource-event Turns.
 */
export function createConversationTurnWorker(
  agentRunner: AgentRunner,
  deliverMessage?: DeliverMessage,
) {
  return async (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ): Promise<ConversationWorkerResult> => {
    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );

    const isResume = resolved.kind === "resume";
    let turnInputFacts: TurnInputFacts | undefined;
    let text = "";
    let turnId = "";
    let userMessageId = "";
    let startedAtMs = Date.now();
    let inputMessageIds: string[] = [];

    const storedConversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });
    const mailboxDestination =
      resolved.kind === "mailbox"
        ? resolved.batch[0]?.message.destination
        : undefined;
    const destination = resolveConversationDestination({
      conversationId: context.conversationId,
      existing:
        context.destination ??
        mailboxDestination ??
        storedConversation?.destination,
    });
    if (resolved.kind === "mailbox") {
      const first = resolved.batch[0]!;
      text = joinMailboxText(resolved.batch.map((entry) => entry.message));
      startedAtMs = first.message.createdAtMs;
      userMessageId = first.message.inboundMessageId;
      turnId = buildDeterministicTurnId(userMessageId);
      inputMessageIds = resolved.batch.map(
        (entry) => entry.message.inboundMessageId,
      );
      turnInputFacts = first;
    } else {
      turnId = resolved.turnId;
    }

    const persisted = await getPersistedThreadState(context.conversationId);
    const conversation = coerceThreadConversationState(persisted);
    await hydrateConversationMessages({
      conversation,
      conversationId: context.conversationId,
    });
    const savedTurn = isResume
      ? await getTurnRecord(context.conversationId, turnId)
      : undefined;
    let savedMessageIsResourceEvent = false;
    if (isResume) {
      const userMessage = getTurnUserMessage(conversation, turnId);
      if (!userMessage) {
        throw new Error(
          `Unable to locate the persisted user message for Turn "${turnId}"`,
        );
      }
      savedMessageIsResourceEvent =
        isResourceEventConversationMessage(userMessage);
      // Resume has no new input. Restore Source and Actor from the Turn.
      // TODO(dcramer): Remove the saved Message fallback after no deployed Turn
      // cursor can omit Source or Actor.
      turnInputFacts = turnInputFactsFromConversationMessage(userMessage, {
        conversationId: context.conversationId,
        location: storedConversation?.location,
        savedActor: savedTurn?.actor,
        savedSource: savedTurn?.source,
        visibility: storedConversation?.visibility,
      });
      userMessageId = userMessage.id;
      text = userMessage.text;
      startedAtMs = userMessage.createdAtMs;
      inputMessageIds = [userMessageId];
    }
    if (!turnInputFacts) {
      throw new Error(
        `Resumed Turn is missing an Actor for Conversation ${context.conversationId}`,
      );
    }
    const { actor, author } = turnInputFacts;
    const source = sourceFromTurnInput({
      conversationId: context.conversationId,
      source: turnInputFacts.source,
      visibility: storedConversation?.visibility,
    });
    const webActor = actor.platform === "web" ? actor : undefined;
    const conversationLocation = storedConversation?.location;
    // TODO(dcramer): Remove the saved Message check after every deployed Turn
    // cursor stores Resource event Source.
    // TODO(dcramer): Remove this Source-based Delivery choice after the core
    // Turn lifecycle stores assistant Messages and web and Resource event work
    // each supplies optional provider Delivery. Source must not select Delivery.
    const deliverToProvider =
      Boolean(conversationLocation) &&
      (source.kind === "resource_event" || savedMessageIsResourceEvent);
    // TODO(dcramer): Stop deriving surface from Delivery after active Turn
    // lookup and reporting read Source for web and Resource event Turns.
    const surface = deliverToProvider ? ("slack" as const) : ("api" as const);

    return await withLogContext(
      {
        conversationId: context.conversationId,
        platform: actor.platform,
        ...(webActor
          ? {
              userId: webActor.userId,
              ...(webActor.userName
                ? { userName: webActor.userName }
                : undefined),
            }
          : undefined),
      },
      async () => {
        let acknowledged = isResume || context.attempt.messages.length === 0;
        const acknowledge = async (): Promise<void> => {
          if (acknowledged) {
            return;
          }
          try {
            await context.attempt.ack();
          } catch {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before mailbox Message acknowledgement for ${context.conversationId}`,
            );
          }
          acknowledged = true;
        };

        let sandboxRef: SandboxRef | undefined =
          getPersistedSandboxState(persisted);
        const initialSandboxRef = sandboxRef;
        const stopSignal = context.stopSignal?.();
        const completeCancelledTurn =
          async (): Promise<ConversationWorkerResult> => {
            try {
              await completeCancelledConversationTurn({
                acknowledge,
                conversation,
                conversationId: context.conversationId,
                sandboxRef,
                turnId,
                userMessageId,
              });
            } catch (error) {
              if (hasLostTurnInputCommit(error)) {
                return { status: "lost_lease" };
              }
              throw error;
            }
            return { status: "completed" };
          };

        if (isResume) {
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
        } else {
          upsertConversationMessage(conversation, {
            id: userMessageId,
            role: "user",
            text: normalizeConversationText(text),
            createdAtMs: startedAtMs,
            author,
            meta: {
              explicitMention: true,
              replied: false,
              ...(source.kind === "web"
                ? { source: "web" as const }
                : undefined),
            },
          });
          await persistConversationMessages({
            conversation,
            conversationId: context.conversationId,
          });
          await lifecycle.start({
            conversationId: context.conversationId,
            createdAtMs: Date.now(),
            inputMessageIds,
            surface,
            turnId,
          });
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
          startActiveTurn({
            conversation,
            nextTurnId: turnId,
          });
        }

        let currentRunId: string | undefined;
        let assistantMessageDelivered = false;
        let failureCode: ConversationTurnFailureCode = "persistence_failed";
        let modelFailureEventId: string | undefined;
        let modelFailureCaptureAttempted = false;
        let completedSuccessfully = false;

        const deliverAssistantMessage = async (
          value: AssistantMessage | string,
        ): Promise<void> => {
          const agentMessage = typeof value === "string" ? undefined : value;
          const replyText =
            typeof value === "string" ? value : getAssistantReplyText(value);
          if (!replyText?.trim()) {
            return;
          }
          failureCode = "delivery_failed";
          let deliveryResult: DeliveryResult | undefined;
          if (deliverToProvider) {
            if (!conversationLocation || !deliverMessage) {
              throw new Error(
                `Conversation ${context.conversationId} cannot deliver to its Location`,
              );
            }
            deliveryResult = await deliverMessage({
              conversationId: context.conversationId,
              location: conversationLocation,
              text: replyText,
            });
          }
          await commitAssistantMessage({
            ...(agentMessage ? { agentMessage } : undefined),
            conversation,
            conversationId: context.conversationId,
            ...(deliveryResult ? { deliveryResult } : undefined),
            sessionId: turnId,
            ...(deliveryResult
              ? { source: "slack" as const }
              : source.kind === "web"
                ? { source: "web" as const }
                : undefined),
            text: replyText,
            userMessageId,
          });
          assistantMessageDelivered = true;
          failureCode = "agent_run_failed";
        };

        try {
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
          if (!isResume) {
            // Match Slack: new input supersedes an auth-paused Turn
            // instead of leaving two active Turns or letting a late OAuth
            // wake resume stale work.
            const pendingAuthorizationActorId =
              conversation.processing.pendingAuth?.actorId;
            const authParked = (
              await listTurnSummaries(context.conversationId)
            ).filter(
              (summary) =>
                summary.surface === "api" &&
                !summary.dispatchId &&
                summary.state === "paused" &&
                summary.resumeReason === "auth",
            );
            for (const parked of authParked) {
              if (stopSignal?.aborted) {
                return await completeCancelledTurn();
              }
              await abandonTurnRecord({
                conversationId: context.conversationId,
                turnId: parked.turnId,
                errorMessage: "Auth-paused Turn superseded by new input",
              });
              // Keep pendingAuth: MCP OAuth still needs it to accept an in-flight
              // connect and store credentials. The abandoned turn record makes a
              // late callback a resume no-op, matching Slack supersede behavior.
              markTurnClosed({
                conversation,
                nowMs: Date.now(),
                sessionId: parked.turnId,
              });
            }
            if (authParked.length > 0 && pendingAuthorizationActorId) {
              // Drop the dashboard connect prompt so a superseded OAuth flow
              // cannot leave a stale banner after the user moves on.
              await deleteWebAuthorization({
                actorId: pendingAuthorizationActorId,
                conversationId: context.conversationId,
              });
            }
          }
          await persistThreadStateById(context.conversationId, {
            conversation,
          });
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
          const piMessages = await loadProjection({
            conversationId: context.conversationId,
          });
          failureCode = "agent_run_failed";
          currentRunId = `conversation-run:${stableHex(turnId, String(startedAtMs))}`;
          setTags({ runId: currentRunId });

          const outcome = await executeTurn(
            agentRunner,
            {
              conversationId: context.conversationId,
              turnId,
              runId: currentRunId,
              instruction: {
                text,
                context: buildConversationContext(conversation, {
                  excludeMessageId: userMessageId,
                }),
              },
              history: piMessages,
              actor,
              credentialContext: credentialContextForActor(actor),
              // TODO(dcramer): Remove AgentRun.destination after agent and tool
              // code reads AgentRun.location and no Run consumer needs it.
              destination,
              source,
              ...(conversationLocation
                ? { location: conversationLocation }
                : undefined),
              surface,
              ...(stopSignal ? { signal: stopSignal } : undefined),
              ...(webActor
                ? {
                    authorization: createWebAuthorization({
                      actorId: webActor.userId,
                      conversationId: context.conversationId,
                    }),
                  }
                : { disabledFeatures: ["interactive-auth"] as const }),
              state: {
                pendingAuth: conversation.processing.pendingAuth,
                sandboxRef,
              },
              delivery: deliverAssistantMessage,
              durability: {
                onInputCommitted: acknowledge,
                shouldYield: context.shouldYield,
                onSandboxRefChanged: async (nextSandboxRef) => {
                  sandboxRef = nextSandboxRef;
                  await persistThreadStateById(context.conversationId, {
                    conversation,
                    sandboxRef,
                  });
                },
                recordPendingAuth: async (pendingAuth) => {
                  conversation.processing.pendingAuth = pendingAuth;
                  await persistThreadStateById(context.conversationId, {
                    conversation,
                    sandboxRef,
                  });
                },
              },
            },
            async (result) => {
              if (stopSignal?.aborted) {
                throw (
                  stopSignal.reason ??
                  new DOMException("Turn cancelled", "AbortError")
                );
              }

              modelFailureCaptureAttempted =
                result.diagnostics.outcome !== "success";
              const finalized = finalizeFailedTurnReplyWithEvent({
                reply: result,
                logException,
              });
              const modelFailureReason = finalized.failureReason;
              const reply = finalized.reply;
              modelFailureEventId = finalized.eventId;
              if (reply.diagnostics.outcome !== "success") {
                await deliverAssistantMessage(reply.text);
              }

              const completedState = buildDeliveredTurnStatePatch({
                conversation,
                reply,
                sessionId: turnId,
                userMessageId,
              });
              await persistThreadStateById(context.conversationId, {
                conversation: completedState.conversation,
                sandboxRef: reply.sandboxRef ?? sandboxRef,
              });
              if (reply.piMessages?.length) {
                // Prefer the live checkpoint slice after yield/resume; first
                // completion has no prior record and starts at slice 1.
                const latest = await getTurnRecord(
                  context.conversationId,
                  turnId,
                );
                await saveTurnCheckpoint({
                  mode: "completed",
                  conversationId: context.conversationId,
                  turnId,
                  sliceId: latest?.sliceId ?? 1,
                  messages: reply.piMessages,
                  durationMs: reply.diagnostics.durationMs,
                  usage: reply.diagnostics.usage,
                  // TODO(dcramer): Remove checkpoint Destination after resume
                  // reads the Conversation Location.
                  destination,
                  source,
                  actor,
                  surface,
                });
              }
              const automatedTurnLimit =
                await recordFinishedTurnForAutomatedLimit({
                  conversationId: context.conversationId,
                  destination,
                  maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                  source,
                });
              await maybePostAutomatedTurnLimitNotice({
                conversationId: context.conversationId,
                destination,
                maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                threadTs:
                  conversationLocation?.provider === "slack"
                    ? conversationLocation.threadTs
                    : undefined,
                update: automatedTurnLimit,
              });

              completedSuccessfully = reply.diagnostics.outcome === "success";
              return completedSuccessfully
                ? {
                    outcome: assistantMessageDelivered ? "success" : "no_reply",
                  }
                : {
                    ...(modelFailureEventId
                      ? { eventId: modelFailureEventId }
                      : undefined),
                    failureCode: "model_execution_failed",
                    ...(modelFailureReason
                      ? { failureReason: modelFailureReason }
                      : undefined),
                    outcome: "failed",
                  };
            },
          );

          if (outcome.status !== "completed" && stopSignal?.aborted) {
            return await completeCancelledTurn();
          }

          if (outcome.status === "suspended") {
            return { status: "yielded" };
          }
          if (outcome.status === "awaiting_auth") {
            // Close the live turn the same way Slack does after private-link
            // delivery. The turn record stays paused for OAuth resume; only
            // the conversation active pointer is cleared.
            completeAuthPauseTurn({
              conversation,
              sessionId: turnId,
            });
            await persistThreadStateById(context.conversationId, {
              conversation,
              sandboxRef,
            });
            await acknowledge();
            return { status: "paused" };
          }
          if (completedSuccessfully) {
            try {
              await scheduleSessionCompletedPluginTasks(
                {
                  conversationId: context.conversationId,
                  sessionId: turnId,
                },
                {
                  send: async (message) => {
                    try {
                      await processPluginTask(message);
                    } catch (error) {
                      logException(
                        error,
                        "conversation.plugin.session_completion_task.failed",
                        {
                          conversationId: context.conversationId,
                          pluginName: message.plugin,
                          taskName: message.name,
                          turnId,
                        },
                      );
                    }
                  },
                },
              );
            } catch (error) {
              logException(
                error,
                "conversation.plugin.session_completion_task.failed",
                {
                  conversationId: context.conversationId,
                  turnId,
                },
              );
            }
          }

          await acknowledge();
          return { status: "completed" };
        } catch (error) {
          const failure = error instanceof AgentRunError ? error.cause : error;
          if (hasLostTurnInputCommit(failure)) {
            return { status: "lost_lease" };
          }
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
          if (!context.attempt.isFinalAttempt) {
            throw failure;
          }

          const failureEventId =
            modelFailureCaptureAttempted && failureCode === "agent_run_failed"
              ? modelFailureEventId
              : captureConversationTurnFailure({
                  conversationId: context.conversationId,
                  error: failure,
                  failureCode,
                  runId: currentRunId,
                  turnId,
                });
          try {
            markTurnFailed({
              conversation,
              nowMs: Date.now(),
              sessionId: turnId,
              userMessageId,
              markConversationMessage,
            });
            await persistThreadStateById(context.conversationId, {
              conversation,
              sandboxRef: initialSandboxRef ?? null,
            });
          } catch (persistenceError) {
            captureConversationTurnFailure({
              conversationId: context.conversationId,
              error: persistenceError,
              failureCode: "persistence_failed",
              runId: currentRunId,
              turnId,
            });
          }
          await lifecycle.fail({
            conversationId: context.conversationId,
            createdAtMs: Date.now(),
            ...(failureEventId ? { eventId: failureEventId } : undefined),
            failureCode,
            turnId,
          });
          await acknowledge();
          return { status: "completed" };
        }
      },
    );
  };
}
