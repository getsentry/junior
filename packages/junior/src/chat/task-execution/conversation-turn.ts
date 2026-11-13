/** Run a mailbox Turn and store its assistant Messages. */
import { blockRunAutomation } from "@/chat/automations/block-run";
import {
  isPersonInput,
  isTopLevelKind,
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
import { loadProjection } from "@/chat/conversations/projection";
import {
  childAgentTurnOptions,
  isParentMessageMeta,
  readParentMessage,
} from "@/chat/agent-invocations/parent-message";
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
import { recordFinishedTurnForAutomatedLimit } from "@/chat/services/automated-turn-limit";
import { maybePostAutomatedTurnLimitNotice } from "@/chat/slack/automated-turn-limit-notice";
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
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
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
  savedTurnInputMessages,
  webConversationMessage,
  webTurnInputs,
} from "@/chat/task-execution/mailbox-input";
import { instructionActorFor, instructionForInputs } from "@/chat/agent/prompt";
import type { AgentInstructionInput } from "@/chat/agent/types";
import { createWebSteeringDrain } from "@/chat/task-execution/web-steering";
import { resolveConversationDestination } from "@/chat/conversations/destination";
import {
  eventBatchMessageMeta,
  isEventMailboxMetadata,
  renderEventBatchInputs,
  savedEventBatchMeta,
  timerWatchCredentialSubject,
} from "@/chat/events/notification";
import { isEventConversationMessage } from "@/chat/events/actor";
import { eventReviewItemInputs } from "@/chat/review-items/prompt-input";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { CredentialSubject } from "@/chat/credentials/context";
import type { Actor } from "@sentry/junior-plugin-api";
import type { Reply } from "@/chat/turn-answer";
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

/**
 * What one child agent Turn sends its parent agent: its `reply`, or a
 * blocked or failed result.
 */
export type ParentResult =
  | { kind: "reply"; reply: Reply }
  | { kind: "blocked" | "failed"; text: string };

/**
 * Send one child agent Turn's result to the parent agent. `actor` is the
 * Actor of the Turn. Repeat calls for one result are safe.
 */
export type DeliverToParent = (args: {
  actor: Actor;
  result: ParentResult;
  conversationId: string;
  turnId: string;
}) => Promise<void>;

/**
 * Create the shared mailbox worker for web and event Turns of every
 * Conversation kind. `deliverMessage` posts to a Location, and
 * `deliverToParent` sends a child agent's results to its parent.
 */
export function createConversationTurnWorker(
  agentRunner: AgentRunner,
  deliverMessage?: DeliverMessage,
  deliverToParent?: DeliverToParent,
) {
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

    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );

    const isResume = resolved.kind === "resume";
    let turnInputFacts: TurnInputFacts | undefined;
    let inputs: AgentInstructionInput[] = [];
    let attachments: MessageAttachment[] = [];
    let turnId = "";
    let userMessageId = "";
    let startedAtMs = Date.now();
    let inputMessageIds: string[] = [];
    let eventMeta: ReturnType<typeof eventBatchMessageMeta> = {};
    let authorIdentityId: string | undefined;
    let webInputMessages: ConversationMessage[] = [];

    const storedConversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });
    const kind = storedConversation?.kind ?? "root";
    // The parent's task can carry the root's private content, so a child
    // with missing visibility runs as private.
    const visibility = isTopLevelKind(kind)
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
      const firstMetadata = first.message.input.metadata;
      if (isEventMailboxMetadata(firstMetadata)) {
        inputs = renderEventBatchInputs(
          messages,
          await eventReviewItemInputs(messages),
        ).map((text) => ({ kind: "runtime", text }));
        eventMeta = eventBatchMessageMeta(messages);
      } else {
        inputs = await webTurnInputs(messages.map((message) => message.input));
        webInputMessages = resolved.batch.map((entry) =>
          webConversationMessage(entry.message, entry.author),
        );
      }
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
    let savedParentMessage = false;
    if (isResume) {
      const userMessage = getTurnUserMessage(conversation, turnId);
      if (!userMessage) {
        throw new Error(
          `Unable to locate the persisted user message for Turn "${turnId}"`,
        );
      }
      savedMessageIsEvent = isEventConversationMessage(userMessage);
      savedParentMessage = isParentMessageMeta(userMessage.meta);
      eventMeta = savedEventBatchMeta(userMessage);
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
      // each Message apart. An Event batch saved one Message with its inputs
      // joined, so it resumes as one input; the prompt is rebuilt only when
      // the Turn paused before its first prompt.
      const turnInputs = savedTurnInputMessages(
        conversation,
        userMessage,
        await lifecycle.loadInputMessageIds(context.conversationId, turnId),
      );
      userMessageId = userMessage.id;
      inputs = savedMessageIsEvent
        ? [{ kind: "runtime", text: userMessage.text }]
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
              resolved.batch.every((entry) => readParentMessage(entry.message)),
            )))
          : await verifiedTimerWatchSubject(
              context.conversationId,
              savedTurn?.credentialSubject,
              savedParentMessage,
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
      personInput: isPersonInput(source.kind),
    });
    const webActor = actor.platform === "web" ? actor : undefined;
    // A child agent's Turn cannot wait for a person to sign in, even when it
    // runs as the web user who started it; missing auth blocks it instead.
    const signInActor =
      behavior.promptMode === "child_agent" ? undefined : webActor;
    const disabledFeatures: AgentFeature[] = signInActor
      ? []
      : ["interactive-auth"];
    const deliverToProvider =
      postsToProvider && behavior.delivery === "location";
    const sendToParent = async (result: ParentResult): Promise<void> => {
      if (!deliverToParent) {
        throw new Error(
          `Conversation ${context.conversationId} cannot reach its parent agent`,
        );
      }
      await deliverToParent({
        actor,
        result,
        conversationId: context.conversationId,
        turnId,
      });
    };
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
            return { status: "completed" };
          };

        if (isResume) {
          if (stopSignal?.aborted) {
            return await completeCancelledTurn();
          }
        } else {
          // Save each web Message apart, so an answer in a batch stays an
          // answer in the transcript and on resume.
          for (const [index, message] of webInputMessages.entries()) {
            upsertConversationMessage(
              conversation,
              index === 0
                ? { ...message, meta: { ...message.meta, replied: false } }
                : message,
            );
          }
          // An Event batch saves one Message with the rendered Events.
          if (webInputMessages.length === 0) {
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
                ...eventMeta,
              },
            });
          }
          await persistConversationMessages({
            conversation,
            conversationId: context.conversationId,
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
          options?: { quiet?: true; reply?: true },
        ): Promise<void> => {
          const agentMessage = typeof value === "string" ? undefined : value;
          const replyText =
            typeof value === "string" ? value : getAssistantReplyText(value);
          if (!replyText?.trim()) {
            return;
          }
          failureCode = "delivery_failed";
          const cards = await loadPendingMessageCards(context.conversationId);
          // Only Event Turns may be quiet: a person who asked always gets the
          // reply. A card means someone must look, so it always delivers.
          const quiet =
            options?.quiet === true && isEventTurn && cards.length === 0;
          let deliveryResult: DeliveryResult | undefined;
          // Read the pause at reply time: a person can pause Delivery while
          // this Turn runs.
          if (
            (options?.reply ? postsToProvider : deliverToProvider) &&
            !quiet &&
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
            ...(quiet ? { quiet } : undefined),
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
            conversationId: context.conversationId,
            history: await loadProjection({
              conversationId: context.conversationId,
            }),
            inputs:
              resolved.kind === "mailbox"
                ? resolved.batch.map((entry) => entry.message)
                : [],
            savedParentMessage,
          });
          const piMessages = childTurn.history;
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
                  hasHistory: piMessages.length > 0,
                  turnId,
                }),
              },
              history: piMessages,
              ...childTurn.run,
              actor,
              credentialContext: credentialContextForActor(
                actor,
                credentialSubject,
              ),
              authorInstructions: eventMeta.authorInstructions,
              untrustedAuthors: eventMeta.untrustedAuthors,
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
                logException,
              });
              const modelFailureReason = finalized.failureReason;
              const reply = finalized.reply;
              modelFailureEventId = finalized.eventId;
              // An answer for the parent is sent before the Turn is saved, so a
              // lost worker cannot save the Turn and drop the answer.
              if (reply.diagnostics.outcome !== "success") {
                await deliverAssistantMessage(reply.text);
                if (behavior.failureNotice === "parent") {
                  await sendToParent({
                    kind: "failed",
                    text: reply.diagnostics.errorMessage ?? reply.text,
                  });
                }
              } else if (reply.reply && behavior.tools.reply === "parent") {
                await sendToParent({ kind: "reply", reply: reply.reply });
              } else if (reply.reply) {
                await deliverAssistantMessage(reply.reply.text, {
                  reply: true,
                });
              } else if (
                reply.blocked &&
                behavior.tools.reportBlocked === "parent"
              ) {
                await sendToParent({
                  kind: "blocked",
                  text: reply.blocked.missing,
                });
              } else if (reply.blocked) {
                await blockRunAutomation(context.conversationId, reply.blocked);
              } else if (reply.noReply?.note && isEventTurn) {
                // The note of a no-reply Event Turn is its Quiet message.
                await deliverAssistantMessage(reply.noReply.note, {
                  quiet: true,
                });
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
                  maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                  source,
                });
              await maybePostAutomatedTurnLimitNotice({
                conversationId: context.conversationId,
                maxTurns: botConfig.maxConsecutiveAutomatedTurns,
                source,
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
          if (completedSuccessfully && behavior.sessionTasks) {
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
            turnId,
          });
          if (behavior.failureNotice === "parent") {
            await sendToParent({
              kind: "failed",
              text:
                failure instanceof Error ? failure.message : String(failure),
            });
          }
          await acknowledge();
          return { status: "completed" };
        }
      },
    );
  };
}
