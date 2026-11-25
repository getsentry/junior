/** Run a mailbox Turn and store its assistant Messages. */
import { blockRunAutomation } from "@/chat/automations/block-run";
import {
  isPersonInput,
  isTopLevel,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import {
  readMessageAttachments,
  type MessageAttachment,
} from "@/chat/attachments/input";
import { isConversationDeliveryPaused } from "@/chat/conversations/delivery-pause";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createWebAuthorization } from "@/chat/conversations/web-authorization";
import { loadConversationProjection } from "@/chat/conversations/projection";
import {
  childAgentTurnOptions,
  commitParentMessageFork,
  isParentMessageAuthor,
} from "@/chat/agent-invocations/parent-message";
import { parentResultActor } from "@/chat/agent-invocations/parent-result";
import { readParentMessage } from "@/chat/agent-invocations/parent-message-input";
import { isChildAgentEvent } from "@/chat/agent-invocations/child-input";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  commitAssistantMessage,
  type DeliverMessage,
  type DeliveryResult,
} from "@/chat/task-execution/assistant-message";
import {
  ConversationTurnLifecycleService,
  getTurnLifecycle,
  type TurnAnswerText,
} from "@/chat/conversations/turn-lifecycle";
import { indexEndedTurnEvents } from "@/chat/conversations/event-embedding";
import { buildTurnThreadContext } from "@/chat/conversations/thread-context";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { logException, setTags } from "@/chat/logging";
import {
  getTurnInputSpanAttributes,
  turnInputTelemetry,
  withTurnSpan,
} from "@/chat/task-execution/turn-telemetry";
import type { AgentFeature } from "@/chat/agent/types";
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
  markTurnFailed,
  startActiveTurn,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { botConfig } from "@/chat/config";
import {
  latestConversationMessageSeq,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  recordFinishedTurnForAutomatedLimit,
  resetAutomatedTurnLimit,
} from "@/chat/services/automated-turn-limit";
import { stopAtAutomatedTurnLimit } from "@/chat/slack/automated-turn-limit-notice";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  failTurnRecord,
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { runTurnEndTasks } from "@/chat/task-execution/turn-end-tasks";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { supersedeOpenMailboxTurns } from "@/chat/task-execution/supersede-turns";
import { completeCancelledConversationTurn } from "@/chat/task-execution/turn-cancel";
import {
  getEventBatchDelayMs,
  sourceFromTurnInput,
  turnInputFactsFromConversationMessage,
  type MailboxTurnWork,
  type TurnInputFacts,
} from "@/chat/task-execution/mailbox-turn";
import {
  mailboxTurnInputs,
  savedTurnInputMessages,
  webTurnInputs,
} from "@/chat/task-execution/mailbox-input";
import {
  instructionActorFor,
  instructionForInputs,
  turnRequestText,
} from "@/chat/agent/prompt";
import type { AgentInstructionInput } from "@/chat/agent/types";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { createWebSteeringDrain } from "@/chat/task-execution/web-steering";
import { resolveConversationDestination } from "@/chat/conversations/destination";
import {
  type eventBatchMessageMeta,
  timerWatchCredentialSubject,
} from "@/chat/events/notification";
import { isEventConversationMessage } from "@/chat/events/actor";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { StateAdapter } from "chat";
import type { CredentialSubject } from "@/chat/credentials/context";
import {
  sharedDelegatedSubject,
  verifiedTimerWatchSubject,
} from "@/chat/task-execution/turn-credentials";

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
  runId?: string | undefined;
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

/**
 * Return the author Identity id that every batched input shares.
 * A batch with more than one author has no single author yet.
 */
function sharedAuthorIdentityId(
  messages: readonly InboundMessage[],
): string | undefined {
  const ids = new Set(
    messages.map((message) => message.input.authorIdentityId),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

// What a Turn that posted no reply answered. A child's final text is its
// reply: it stays in the transcript, and its update carries it.
function turnAnswerText(reply: AgentRunResult): TurnAnswerText | undefined {
  if (reply.reply) return undefined;
  if (reply.blocked) return { kind: "note", text: reply.blocked.missing };
  if (reply.noReply) return { kind: "note", text: reply.noReply.note ?? "" };
  const text = reply.text.trim();
  return text ? { kind: "final_text", text } : undefined;
}

/**
 * Create the shared mailbox worker for web and event Turns of every
 * Conversation kind. `deliverMessage` posts to a Location. `updates` is
 * where each Turn's agent update goes, to the starter of a child agent and
 * to the Watches of any Conversation, by default the production queue.
 */
export function createConversationTurnWorker(
  agentRunner: AgentRunner,
  deliverMessage?: DeliverMessage,
  updates?: { queue: ConversationWorkQueue; state?: StateAdapter | undefined },
) {
  const lifecycle = updates
    ? new ConversationTurnLifecycleService(getConversationEventStore(), {
        state: updates.state,
        watchQueue: () => updates.queue,
      })
    : getTurnLifecycle();
  return async (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ): Promise<ConversationWorkerResult> => {
    // Wait out the event debounce window without sleeping in process. The
    // worker re-enqueues this wake with the remaining delay.
    if (resolved.kind === "mailbox") {
      const delayMs = getEventBatchDelayMs(
        resolved.batch.map((entry) => entry.message),
      );
      if (delayMs > 0) return { status: "deferred", delayMs };
    }

    const isResume = resolved.kind === "resume";
    let turnInputFacts: TurnInputFacts | undefined;
    let inputs: AgentInstructionInput[] = [];
    let attachments: MessageAttachment[] = [];
    let turnId = "";
    let userMessageId = "";
    let startedAtMs = Date.now();
    let inputMessageIds: string[] = [];
    let eventMeta: ReturnType<typeof eventBatchMessageMeta> = {};
    // A parent agent's task or message. On resume, its saved author says so.
    let fromParent =
      resolved.kind === "mailbox" &&
      resolved.batch.every((entry) => readParentMessage(entry.message));
    let fromChildAgent = false;
    let authorIdentityId: string | undefined;
    let webInputMessages: ConversationMessage[] = [];

    const storedConversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });
    const kind = storedConversation?.kind ?? "thread";
    // The parent's task can carry the root's private content, so a child
    // with missing visibility runs as private.
    const visibility = isTopLevel({
      parentConversationId: storedConversation?.parentConversationId,
    })
      ? storedConversation?.visibility
      : (storedConversation?.visibility ?? "private");
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
      const messages = resolved.batch.map((entry) => entry.message);
      ({ eventMeta, inputs, webInputMessages } = await mailboxTurnInputs(
        resolved.batch,
        fromParent,
      ));
      fromChildAgent = isChildAgentEvent(eventMeta);
      attachments = resolved.batch.flatMap((entry) =>
        readMessageAttachments(entry.message.input.attachments),
      );
      startedAtMs = first.message.createdAtMs;
      userMessageId = first.message.inboundMessageId;
      turnId = buildDeterministicTurnId(userMessageId);
      inputMessageIds = resolved.batch.map(
        (entry) => entry.message.inboundMessageId,
      );
      authorIdentityId = sharedAuthorIdentityId(messages);
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
    let savedMessageIsEvent = false;
    if (isResume) {
      const userMessage = getTurnUserMessage(conversation, turnId);
      if (!userMessage) {
        throw new Error(
          `Unable to locate the persisted user message for Turn "${turnId}"`,
        );
      }
      savedMessageIsEvent = isEventConversationMessage(userMessage);
      fromParent = isParentMessageAuthor(userMessage.author);
      fromChildAgent = isChildAgentEvent(userMessage.meta);
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
      // Rebuild the inputs from every saved input Message. A web batch saved
      // each Message apart. An Event or parent batch saved one Message with
      // its inputs joined, so it resumes as one input; the prompt is rebuilt only when
      // the Turn paused before its first prompt.
      const turnInputs = savedTurnInputMessages(
        conversation,
        userMessage,
        await lifecycle.loadInputMessageIds(context.conversationId, turnId),
      );
      userMessageId = userMessage.id;
      inputs =
        savedMessageIsEvent || fromParent
          ? [
              {
                kind: "runtime",
                text: userMessage.text,
                ...(userMessage.meta?.requestText
                  ? { requestText: userMessage.meta.requestText }
                  : undefined),
              },
            ]
          : await webTurnInputs(
              turnInputs.map((message) => ({
                reviewItemChange: message.meta?.reviewItemChanges?.[0],
                text: message.text,
              })),
            );
      attachments = turnInputs.flatMap(
        (message) => message.meta?.attachments ?? [],
      );
      startedAtMs = userMessage.createdAtMs;
      inputMessageIds = turnInputs.map((message) => message.id);
    }
    if (!turnInputFacts) {
      throw new Error(
        `Resumed Turn is missing an Actor for Conversation ${context.conversationId}`,
      );
    }
    const { actor, author } = turnInputFacts;
    const instructionInputs = instructionForInputs(inputs);
    const { text } = instructionInputs;
    const instructionActor = instructionActorFor(actor);
    // A timer Turn stays system-acted but may use its creator's grants. So
    // does the result of a child agent that a timer Turn spawned.
    let credentialSubject: CredentialSubject | undefined;
    if (actor.platform === "system") {
      credentialSubject =
        resolved.kind === "mailbox"
          ? (timerWatchCredentialSubject(
              context.conversationId,
              resolved.batch.map((entry) => entry.message),
            ) ??
            (await verifiedTimerWatchSubject(
              context.conversationId,
              sharedDelegatedSubject(resolved.batch),
              fromParent,
            )))
          : await verifiedTimerWatchSubject(
              context.conversationId,
              savedTurn?.credentialSubject,
              fromParent,
            );
    }
    const source = sourceFromTurnInput({
      conversationId: context.conversationId,
      source: turnInputFacts.source,
      visibility,
    });
    const conversationLocation = storedConversation?.location;
    // TODO(dcramer): Remove the saved Message check after every deployed Turn
    // cursor stores Event Source.
    // TODO(dcramer): Remove this Source-based Delivery choice after the core
    // Turn lifecycle stores assistant Messages and web and Event work
    // each supplies optional provider Delivery. Source must not select Delivery.
    const isEventTurn = source.kind === "event" || savedMessageIsEvent;
    // Only an Event Turn delivers here, and an Event has no person.
    const postsToProvider = Boolean(conversationLocation) && isEventTurn;
    const behavior = turnBehavior({
      kind,
      hasParent: !isTopLevel({
        parentConversationId: storedConversation?.parentConversationId,
      }),
      personInput: isPersonInput(source.kind),
    });
    const webActor = actor.platform === "web" ? actor : undefined;
    const signInActor = behavior.waitsForSignIn ? webActor : undefined;
    const disabledFeatures: AgentFeature[] = signInActor
      ? []
      : ["interactive-auth"];
    const deliverToProvider =
      postsToProvider && behavior.delivery === "location";
    // TODO(dcramer): Stop deriving surface from Delivery after active Turn
    // lookup and reporting read Source for web and Event Turns.
    const surface = postsToProvider ? ("slack" as const) : ("api" as const);

    // Input timing applies to new input. A resumed slice continues the trace
    // of its first slice.
    const inputTelemetry =
      resolved.kind === "mailbox"
        ? turnInputTelemetry(resolved.batch.map((entry) => entry.message))
        : undefined;
    const turnTrace =
      inputTelemetry ??
      (savedTurn?.traceContext
        ? { traceContexts: [savedTurn.traceContext] }
        : undefined);

    return await withTurnSpan(
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
      turnTrace,
      async (setTurnSpanAttributes) => {
        if (inputTelemetry) {
          setTurnSpanAttributes(
            getTurnInputSpanAttributes(inputTelemetry, Date.now()),
          );
        }
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
            await indexEndedTurnEvents({
              conversationId: context.conversationId,
              turnId,
            });
            return { status: "completed" };
          };

        if (isResume) {
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
        } else {
          // Save each web Message apart, so an answer in a batch stays an
          // answer in the transcript and on resume.
          for (const message of webInputMessages) {
            upsertConversationMessage(conversation, message);
          }
          // An Event or parent batch saves one Message with its inputs.
          if (webInputMessages.length === 0) {
            const requestText = turnRequestText({
              instruction: instructionInputs,
            });
            upsertConversationMessage(conversation, {
              id: userMessageId,
              role: "user",
              text: normalizeConversationText(text),
              createdAtMs: startedAtMs,
              author,
              ...(authorIdentityId ? { authorIdentityId } : undefined),
              meta: {
                ...(attachments.length ? { attachments } : undefined),
                explicitMention: true,
                replied: false,
                ...(requestText ? { requestText } : undefined),
                ...eventMeta,
              },
            });
          }
          await persistConversationMessages({
            conversation,
            conversationId: context.conversationId,
          });
          await commitParentMessageFork({
            conversationId: context.conversationId,
            inputs: resolved.batch.map((entry) => entry.message),
          });
          await lifecycle.start({
            conversationId: context.conversationId,
            createdAtMs: Date.now(),
            inputMessageIds,
            surface,
            threadContextThroughSeq: latestConversationMessageSeq(conversation),
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
          options?: { reply?: true },
        ): Promise<void> => {
          const agentMessage = typeof value === "string" ? undefined : value;
          const replyText =
            typeof value === "string" ? value : getAssistantReplyText(value);
          if (!replyText?.trim()) {
            return;
          }
          failureCode = "delivery_failed";
          const cards = await loadPendingMessageCards(context.conversationId);
          let deliveryResult: DeliveryResult | undefined;
          // Read the pause at reply time: a person can pause Delivery while
          // this Turn runs.
          if (
            (options?.reply ? postsToProvider : deliverToProvider) &&
            !(await isConversationDeliveryPaused(context.conversationId))
          ) {
            if (!conversationLocation || !deliverMessage) {
              throw new Error(
                `Conversation ${context.conversationId} cannot deliver to its Location`,
              );
            }
            deliveryResult = await deliverMessage({
              cards,
              conversationId: context.conversationId,
              location: conversationLocation,
              text: replyText,
            });
          }
          await commitAssistantMessage({
            cards,
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
          // Match Slack: new input supersedes every other open mailbox Turn.
          // A second open Turn makes every later resume fail.
          if (
            !isResume &&
            !(await supersedeOpenMailboxTurns({
              conversation,
              conversationId: context.conversationId,
              isStopped: () => Boolean(stopSignal?.aborted),
              keepTurnId: turnId,
            }))
          ) {
            return await completeCancelledTurn();
          }
          await persistThreadStateById(context.conversationId, {
            conversation,
          });
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
          const childTurn = await childAgentTurnOptions({
            actor,
            conversationId: context.conversationId,
            fromChildAgent,
            fromParent,
          });
          const history = await loadConversationProjection({
            conversationId: context.conversationId,
          });
          failureCode = "agent_run_failed";
          currentRunId = `conversation-run:${stableHex(turnId, String(startedAtMs))}`;
          setTags({ runId: currentRunId });

          const outcome = await executeTurn(
            agentRunner,
            {
              conversationId: context.conversationId,
              ...(storedConversation?.parentConversationId
                ? {
                    parentConversationId:
                      storedConversation.parentConversationId,
                  }
                : undefined),
              turnId,
              runId: currentRunId,
              instruction: {
                ...instructionInputs,
                ...(instructionActor ? { actor: instructionActor } : undefined),
                ...childTurn.instruction,
                storedAttachments: attachments,
                context: await buildTurnThreadContext({
                  conversation,
                  conversationId: context.conversationId,
                  excludeMessageIds: inputMessageIds,
                  hasHistory: history.messages.length > 0,
                  turnId,
                }),
              },
              history,
              ...childTurn.run,
              actor,
              credentialContext: credentialContextForActor(
                actor,
                credentialSubject,
              ),
              // TODO(dcramer): Remove AgentRun.destination after agent and tool
              // code reads AgentRun.location and no Run consumer needs it.
              destination,
              source,
              ...(conversationLocation
                ? { location: conversationLocation }
                : undefined),
              surface,
              ...(stopSignal ? { signal: stopSignal } : undefined),
              ...(signInActor
                ? {
                    authorization: createWebAuthorization({
                      actorId: signInActor.userId,
                      conversationId: context.conversationId,
                    }),
                  }
                : undefined),
              ...(disabledFeatures.length > 0
                ? { disabledFeatures }
                : undefined),
              state: {
                pendingAuth: conversation.processing.pendingAuth,
                sandboxRef,
              },
              delivery: deliverAssistantMessage,
              durability: {
                ...(webActor
                  ? {
                      drainSteeringMessages: createWebSteeringDrain({
                        actor: webActor,
                        author,
                        context,
                        conversation,
                        turnId,
                      }),
                    }
                  : undefined),
                onInputCommitted: acknowledge,
                shouldYield: context.shouldYield,
                checkIn: context.checkIn,
                checkStop: context.checkStop,
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
              });
              const modelFailureReason = finalized.failureReason;
              const reply = finalized.reply;
              modelFailureEventId = finalized.eventId;
              // The Turn's end, also a child's final text, `noReply` note, or
              // blocked report, reaches its starter and Watches as one agent
              // update when the lifecycle records it.
              if (reply.diagnostics.outcome !== "success") {
                await deliverAssistantMessage(reply.text);
              } else if (reply.reply) {
                await deliverAssistantMessage(reply.reply.text, {
                  reply: true,
                });
              } else if (
                reply.blocked &&
                behavior.tools.reportBlocked === "automation"
              ) {
                await blockRunAutomation(context.conversationId, reply.blocked);
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
              if (fromParent) {
                // A parent agent's task resets the limit, as a person's
                // Message does.
                await resetAutomatedTurnLimit({
                  conversationId: context.conversationId,
                });
              } else {
                const automatedTurnLimit =
                  await recordFinishedTurnForAutomatedLimit({
                    conversationId: context.conversationId,
                    maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                    source,
                  });
                await stopAtAutomatedTurnLimit({
                  conversationId: context.conversationId,
                  maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                  source,
                  update: automatedTurnLimit,
                });
              }

              completedSuccessfully = reply.diagnostics.outcome === "success";
              const delivered = assistantMessageDelivered
                ? "success"
                : "no_reply";
              const answer = turnAnswerText(reply);
              return completedSuccessfully
                ? {
                    ...(answer ? { answer } : undefined),
                    outcome: reply.blocked ? "blocked" : delivered,
                  }
                : {
                    ...(modelFailureEventId
                      ? { eventId: modelFailureEventId }
                      : undefined),
                    failureCode: "model_execution_failed",
                    ...(modelFailureReason
                      ? { failureReason: modelFailureReason }
                      : undefined),
                    failureText: reply.diagnostics.errorMessage ?? reply.text,
                    outcome: "failed",
                  };
            },
            lifecycle,
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
          await runTurnEndTasks({
            behavior,
            completed: completedSuccessfully,
            conversationId: context.conversationId,
            turnId,
          });

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
          // Fail the Turn record too, or a later wake with no new input
          // resumes this Turn as the open mailbox Turn (JUNIOR-9M). Its own
          // try so a lock timeout here still fails the Conversation copy.
          try {
            const latest = await getTurnRecord(context.conversationId, turnId);
            if (latest) {
              await failTurnRecord({
                conversationId: context.conversationId,
                errorMessage:
                  failure instanceof Error ? failure.message : String(failure),
                expectedVersion: latest.version,
                turnId,
              });
            }
          } catch (turnRecordError) {
            captureConversationTurnFailure({
              conversationId: context.conversationId,
              error: turnRecordError,
              failureCode: "persistence_failed",
              runId: currentRunId,
              turnId,
            });
          }
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
            failureText:
              failure instanceof Error ? failure.message : String(failure),
            reportAs: parentResultActor(actor, source.kind),
            turnId,
          });
          await indexEndedTurnEvents({
            conversationId: context.conversationId,
            turnId,
          });
          await acknowledge();
          return { status: "completed" };
        }
      },
    );
  };
}
