/**
 * Add Slack behavior around one Turn.
 *
 * This module owns Slack status, delivery, and state.
 * It calls `executeTurn` to run and finish the Turn.
 */
import type { Message, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import {
  defaultModelId,
  modelIdForProfile,
  type ModelProfile,
} from "@/chat/model-profile";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { readSlackActionToken } from "@/chat/slack/action-token";
import {
  logException,
  getActiveTraceId,
  logInfo,
  logWarn,
  setSentryUser,
  setSpanAttributes,
  setTags,
  withSpan,
} from "@/chat/logging";
import { sendSlackReply } from "@/chat/slack/reply";
import {
  buildSlackOutputMessage,
  splitSlackReplyText,
} from "@/chat/slack/output";
import {
  getSlackErrorObservabilityAttributes,
  isRetryableSlackPostError,
} from "@/chat/slack/errors";
import { buildSteeringPiMessage } from "@/chat/agent/prompt";
import {
  RetryableDeliveryError,
  type AgentRun,
  type AgentSteeringMessage,
} from "@/chat/agent/types";
import { AgentRunError, type ExecuteTurn } from "@/chat/runtime/turn-execution";
import {
  credentialContextForActor,
  type CredentialContext,
} from "@/chat/credentials/context";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  getAssistantThreadContext,
  getChannelId,
  getMessageTs,
  getThreadId,
  getThreadTs,
  getRunId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";
import {
  parseContent,
  replaceTopLevelText,
} from "@/chat/slack/message/content";
import {
  persistThreadRuntimeState,
  persistThreadState,
} from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  type PrepareTurnStateInput,
  type QueuedTurnMessage,
  type TurnMessageText,
  type TurnToolInvocation,
} from "@/chat/runtime/turn-input";
import {
  markConversationMessage,
  normalizeConversationText,
  recordDeliveredAssistantMessage,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type { ContextCompactor } from "@/chat/services/context-compaction";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/slack/vision-context";
import {
  createSlackAdapterAssistantStatusSession,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status";
import { resolveConversationTitle } from "@/chat/services/conversation-title";
import { maybeSyncAssistantTitle } from "@/chat/slack/assistant-thread/title";
import {
  conversationVisibilityFromSlackChannelType,
  resolveSlackChannelTypeFromMessage,
  resolveSlackConversationContext,
} from "@/chat/slack/conversation-context";
import { lookupSlackUser } from "@/chat/slack/user";
import { parseActorUserId, type Actor } from "@/chat/actor";
import { ensureSlackMessageActorIdentity } from "@/chat/services/message-actor-identity";
import {
  isResourceEventSlackMessage,
  RESOURCE_EVENT_SYSTEM_ACTOR,
} from "@/chat/resource-events/actor";
import type { PausedTurnRequest } from "@/chat/task-execution/turn-wake";
import {
  ConversationTurnBoundaryError,
  CooperativeTurnYieldError,
  getConversationTurnBoundaryError,
  TurnInputDeferredError,
} from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import { markTurnClosed, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import {
  finalizeFailedTurnReplyWithEvent,
  getAgentTurnDiagnosticsAttributes,
} from "@/chat/services/turn-failure-response";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { maybeApplyProviderDefaultConfigRequest } from "@/chat/services/provider-default-config";
import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import {
  abandonTurnRecord,
  failTurnRecord,
  getTurnRecord,
  recordTurnSummary,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { resolveDestinationVisibility } from "@/chat/conversations/destination-visibility";
import {
  commitAcceptedReply,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { persistWithRetry } from "@/chat/services/persist-retry";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { requireSlackDestination } from "@/chat/destination";
import { persistConversationMessages } from "@/chat/conversations/messages";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type {
  DispatchTurnContext,
  DispatchTurnResult,
} from "@/chat/agent-dispatch/types";
import {
  appendRecentMessagesToContext,
  collectAttachments,
  inboundMessageActor,
  inboundMessageProvenance,
  resolveChannelName,
  saveSteeringMessages,
  steeringMessageKey,
} from "@/chat/providers/slack/input";

/**
 * Persist post-delivery Redis scratch with a short retry after durable SQL
 * completion has succeeded.
 */
async function persistThreadRuntimeStateWithRetry(
  thread: Thread,
  patch: Parameters<typeof persistThreadState>[1],
): Promise<void> {
  await persistWithRetry(() => persistThreadRuntimeState(thread, patch));
}

interface LoadedPiMessagesForTurn {
  canCompact?: boolean;
  modelProfile?: ModelProfile;
  piMessages?: PiMessage[];
}

/**
 * Resolve the Pi history for this Slack turn from the most precise durable
 * boundary available: active turn record first, then compactable projection.
 * Both are SQL-backed; there is no thread-state fallback.
 */
async function loadPiMessagesForTurn(args: {
  conversationId?: string;
  activeTurnId?: string;
}): Promise<LoadedPiMessagesForTurn> {
  if (!args.conversationId) {
    return {};
  }

  if (args.activeTurnId) {
    const sessionRecord = await getTurnRecord(
      args.conversationId,
      args.activeTurnId,
    );
    if (sessionRecord?.piMessages.length) {
      return {
        piMessages: stripRuntimeTurnContext(
          trimTrailingAssistantMessages(sessionRecord.piMessages),
        ),
      };
    }
  }

  const projection = await loadConversationProjection({
    conversationId: args.conversationId,
  });
  if (projection.messages.length > 0) {
    return {
      canCompact: true,
      modelProfile: projection.modelProfile,
      piMessages: projection.messages,
    };
  }

  return {};
}

export interface SlackTurnServices {
  contextCompactor: ContextCompactor;
  getPausedTurnRequest: (args: {
    conversationId: string;
    turnId: string;
  }) => Promise<PausedTurnRequest | undefined>;
  lookupSlackUser: typeof lookupSlackUser;
  turnLifecycle: ConversationTurnLifecycle;
  wakePausedTurn: (request: PausedTurnRequest) => Promise<void>;
  scheduleSessionCompletedPluginTasks: (params: {
    conversationId: string;
    sessionId: string;
  }) => Promise<void>;
}

interface SlackTurnDeps {
  executeTurn: ExecuteTurn;
  getSlackAdapter: () => SlackAdapter;
  resolveUserAttachments: (
    attachments: Message["attachments"] | undefined,
    context: {
      threadId?: string;
      actorId?: string;
      channelId?: string;
      runId?: string;
      conversation?: PreparedTurnState["conversation"];
      messageTs?: string;
    },
  ) => Promise<
    Array<{
      data?: Buffer;
      mediaType: string;
      filename?: string;
      promptText?: string;
    }>
  >;
  prepareTurnState: (args: PrepareTurnStateInput) => Promise<PreparedTurnState>;
  services: SlackTurnServices;
}

/** Return whether the Slack caller should publish destination output. */
function shouldPublishExternally(publishExternally?: boolean): boolean {
  return publishExternally !== false;
}

/** Build the Slack caller that prepares input and delivers output for a Turn. */
export function createSlackTurn(deps: SlackTurnDeps) {
  return async function executeSlackTurn(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      conversationId?: string;
      destination: Destination;
      explicitMention?: boolean;
      ack?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnDeliveryAccepted?: (messageId?: string) => void;
      onTurnOutcome?: (result: DispatchTurnResult) => void;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: PreparedTurnState;
      queuedMessages?: QueuedTurnMessage[];
      publishExternally?: boolean;
      execution?: DispatchTurnContext;
      skipBackfill?: boolean;
      drainSteeringMessages?: (
        accept: (messages: QueuedTurnMessage[]) => Promise<void>,
        context?: { conversationContext?: string },
      ) => Promise<QueuedTurnMessage[]>;
      shouldYield?: () => boolean;
    },
  ) {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const channelName =
      !options.execution && channelId
        ? await resolveChannelName(thread)
        : undefined;
    const destination = requireSlackDestination(
      options.destination,
      "Slack reply execution",
    );
    const slackChannelType = resolveSlackChannelTypeFromMessage(message);
    const slackConversation = resolveSlackConversationContext({
      channelId,
      channelName,
      channelType: slackChannelType,
    });
    const destinationVisibility = await resolveDestinationVisibility({
      destination,
      visibility:
        options.execution?.destinationVisibility ??
        conversationVisibilityFromSlackChannelType(slackChannelType),
    });
    const assistantThreadContext = getAssistantThreadContext(message);
    const threadTs = getThreadTs(threadId) ?? assistantThreadContext?.threadTs;
    const messageTs = getMessageTs(message);
    const teamId = destination.teamId;
    const source =
      options.execution?.source ??
      createSlackSource({
        channelId: channelId ?? destination.channelId,
        messageTs,
        teamId,
        threadTs,
        visibility: destinationVisibility ?? "private",
      });
    const slackActionToken = readSlackActionToken(message);
    const runId = options.execution?.dispatch?.id ?? getRunId(thread, message);
    const conversationId = options.conversationId ?? threadId ?? runId;
    if (!conversationId) {
      throw new Error("Slack reply execution requires a conversation id");
    }

    await withSpan(
      "chat.reply",
      "chat.reply",
      {
        conversationId,
        messageConversationId: threadId,
        userId: message.author.userId,
        destinationName: channelId,
        runId,
        assistantUserName: botConfig.userName,
        modelId: defaultModelId(botConfig),
      },
      async () => {
        const content = parseContent(message);
        const strippedUserText = stripLeadingBotMention(
          stripLeadingSteeringOverride(content.topLevelText),
          {
            botUserId: deps.getSlackAdapter().botUserId,
            stripLeadingSlackMentionToken:
              options.explicitMention || Boolean(message.isMention),
          },
        );
        const currentText: TurnMessageText = {
          rawText: content.text,
          userText: replaceTopLevelText(content, strippedUserText),
        };
        await Promise.all(
          (options.queuedMessages ?? [])
            .filter((queued) => !isResourceEventSlackMessage(queued.message))
            .map((queued) =>
              ensureSlackMessageActorIdentity(
                queued.message,
                teamId,
                deps.services.lookupSlackUser,
              ),
            ),
        );
        const effectiveUserText = currentText.userText;
        // Actor first, then credential projection. Dispatch already binds both
        // (and any delegated subject); other turns derive credentials from actor.
        let executionActor: Actor | undefined;
        let credentialContext: CredentialContext | undefined;
        if (options.execution) {
          // Dispatch always owns actor + credentials (including subject).
          executionActor = options.execution.dispatch.actor;
          credentialContext = options.execution.credentialContext;
        } else if (isResourceEventSlackMessage(message)) {
          executionActor = RESOURCE_EVENT_SYSTEM_ACTOR;
          credentialContext = credentialContextForActor(executionActor);
        } else {
          executionActor = await ensureSlackMessageActorIdentity(
            message,
            teamId,
            deps.services.lookupSlackUser,
          );
          if (executionActor) {
            credentialContext = credentialContextForActor(executionActor);
          }
        }
        if (!executionActor || !credentialContext) {
          throw new Error("Slack reply execution requires an actor");
        }
        const actor = "userId" in executionActor ? executionActor : undefined;
        const slackActorId = actor?.userId;

        const preparedState =
          options.preparedState ??
          (await deps.prepareTurnState({
            thread,
            message,
            text: currentText,
            explicitMention: Boolean(
              options.explicitMention || message.isMention,
            ),
            queuedMessages: options.queuedMessages,
            destination,
            locationConfiguration: options.execution?.locationConfiguration,
            context: {
              threadId,
              actorId: slackActorId,
              channelId,
              runId,
            },
            skipBackfill: options.skipBackfill,
          }));

        const slackMessageTs = getMessageTimestamp(message);
        const turnId =
          options.execution?.turnId ?? buildDeterministicTurnId(message.id);
        let beforeFirstResponsePostCalled = false;
        const beforeFirstResponsePost = async (): Promise<void> => {
          if (beforeFirstResponsePostCalled) {
            return;
          }
          beforeFirstResponsePostCalled = true;
          await options.beforeFirstResponsePost?.();
        };
        const postAuthPauseNotice = async (
          providerDisplayName: string,
          requestText?: string,
        ): Promise<void> => {
          if (!actor) {
            throw new Error("Slack auth pause notice requires an actor");
          }
          const text = buildAuthPauseResponse(
            actor.userId,
            providerDisplayName,
            requestText,
          );
          try {
            await beforeFirstResponsePost();
            if (!shouldPublishExternally(options.publishExternally)) {
              return;
            }
            if (channelId && threadTs) {
              await sendSlackReply({
                channelId,
                conversationId,
                replyAttribution: options.execution?.dispatch?.replyAttribution,
                text,
                threadTs,
              });
            } else {
              await thread.post(buildSlackOutputMessage(text));
            }
          } catch (error) {
            logException(error, "slack.auth_pause.notice_post.failed", {
              "app.slack.reply_stage": "thread_reply_auth_pause_notice",
              ...(messageTs
                ? { "messaging.message.id": messageTs }
                : undefined),
              ...getSlackErrorObservabilityAttributes(error),
            });
          }
        };
        let activeTurnId = preparedState.conversation.processing.activeTurnId;
        const resolveSteeringMessages = async (
          queuedMessages: QueuedTurnMessage[],
        ): Promise<AgentSteeringMessage[]> => {
          return await Promise.all(
            queuedMessages.map(async (queued) => {
              const attachments = queued.message.attachments;
              return {
                actor: inboundMessageActor(queued),
                provenance: inboundMessageProvenance(queued, teamId),
                text: queued.userText,
                timestampMs: queued.message.metadata.dateSent.getTime(),
                omittedImageAttachmentCount:
                  !isVisionEnabled() && hasPotentialImageAttachment(attachments)
                    ? countPotentialImageAttachments(attachments)
                    : 0,
                attachments: await deps.resolveUserAttachments(attachments, {
                  threadId,
                  actorId: isResourceEventSlackMessage(queued.message)
                    ? undefined
                    : queued.message.author.userId,
                  channelId,
                  runId,
                  conversation: preparedState.conversation,
                  messageTs: getMessageTimestamp(queued.message),
                }),
              };
            }),
          );
        };
        /** Save new messages before completing the mailbox delivery. */
        const saveMessagesForPausedTurn = async (
          pausedTurnId: string,
        ): Promise<boolean> => {
          if (!conversationId) {
            return true;
          }
          const messagesForPausedTurn = [
            ...(options.queuedMessages ?? []),
            {
              explicitMention: Boolean(
                options.explicitMention || message.isMention,
              ),
              message,
              rawText: currentText.rawText,
              userText: currentText.userText,
            },
          ].filter(
            // Redelivery of the paused Turn's own message must not duplicate
            // the prompt that already started the session.
            (queued) =>
              buildDeterministicTurnId(queued.message.id) !== pausedTurnId,
          );
          if (messagesForPausedTurn.length === 0) {
            return true;
          }
          const steeringMessages = (
            await resolveSteeringMessages(messagesForPausedTurn)
          ).map((steering) => ({
            message: buildSteeringPiMessage(steering),
            provenance: steering.provenance,
          }));
          return saveSteeringMessages({
            conversationId,
            messages: steeringMessages,
          });
        };
        if (preparedState.userMessageAlreadyReplied) {
          const deliveredMessage = [...preparedState.conversation.messages]
            .reverse()
            .find(
              (candidate) =>
                candidate.role === "assistant" &&
                candidate.id.startsWith(`${turnId}:assistant:`) &&
                candidate.meta?.replied === true,
            );
          options.onTurnDeliveryAccepted?.(deliveredMessage?.meta?.slackTs);
          options.onTurnOutcome?.({ outcome: "completed" });
          await persistThreadState(thread, {
            conversation: preparedState.conversation,
          });
          await options.onTurnStatePersisted?.();
          await options.ack?.();
          await options.onTurnCompleted?.();
          return;
        }
        if (conversationId && activeTurnId) {
          const pausedTurn = await deps.services.getPausedTurnRequest({
            conversationId,
            turnId: activeTurnId,
          });
          if (pausedTurn) {
            // Save agent input before resuming the Turn. Complete the mailbox
            // delivery only after that input is visible in agent history.
            if (!(await saveMessagesForPausedTurn(pausedTurn.turnId))) {
              // A resumed Run is saving the same history. Keep this mailbox
              // delivery pending until that Run finishes.
              throw new TurnInputDeferredError();
            }
            try {
              await deps.services.wakePausedTurn(pausedTurn);
            } catch (error) {
              logException(error, "agent.continue.schedule.failed", {
                "app.ai.resume_session_version": pausedTurn.expectedVersion,
                "app.ai.resume_session_id": pausedTurn.turnId,
                ...(messageTs
                  ? { "messaging.message.id": messageTs }
                  : undefined),
              });
              throw error;
            }

            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            await options.onTurnStatePersisted?.();
            await options.ack?.();
            return;
          }

          const sessionRecord = await getTurnRecord(
            conversationId,
            activeTurnId,
          );
          if (sessionRecord?.state === "paused") {
            if (sessionRecord.resumeReason === "auth") {
              // A user follow-up replaces a Turn paused for authorization.
              // Answer it as a new Turn. The original agent input remains in
              // history, and the authorization link remains valid. A later
              // authorization response finds the abandoned Turn and cannot
              // start a competing Run.
              await abandonTurnRecord({
                conversationId,
                turnId: activeTurnId,
                // TODO(dcramer): Rename this legacy text in Slack and Conversation API Turn records together.
                errorMessage:
                  "Auth-parked session superseded by a new user message",
              });
              markTurnClosed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: activeTurnId,
              });
              activeTurnId = undefined;
            } else {
              await failTurnRecord({
                conversationId,
                expectedVersion: sessionRecord.version,
                turnId: activeTurnId,
                errorMessage:
                  "Awaiting paused-turn metadata could not be materialized",
              });
              markTurnFailed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: activeTurnId,
                markConversationMessage,
              });
              activeTurnId = undefined;
            }
          }
        }
        const configReply = options.execution?.skipProviderDefaultConfig
          ? undefined
          : await maybeApplyProviderDefaultConfigRequest({
              locationConfiguration: preparedState.locationConfiguration,
              actorId: actor?.userId,
              text: effectiveUserText,
            });
        if (configReply) {
          await beforeFirstResponsePost();
          if (shouldPublishExternally(options.publishExternally)) {
            await thread.post(buildSlackOutputMessage(configReply.text));
          }
          markConversationMessage(
            preparedState.conversation,
            preparedState.userMessageId,
            {
              replied: true,
              skippedReason: undefined,
            },
          );
          upsertConversationMessage(preparedState.conversation, {
            id: buildDeterministicAssistantMessageId(turnId),
            role: "assistant",
            text: normalizeConversationText(configReply.text),
            createdAtMs: Date.now(),
            author: {
              userName: botConfig.userName,
              isBot: true,
            },
            meta: {
              replied: true,
              source: "slack",
            },
          });
          await persistThreadState(thread, {
            conversation: preparedState.conversation,
          });
          await options.onTurnStatePersisted?.();
          await options.ack?.();
          return;
        }
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
        });
        if (conversationId && preparedState.userMessageId) {
          await deps.services.turnLifecycle.start({
            conversationId,
            createdAtMs: Date.now(),
            inputMessageIds: [
              ...new Set([
                ...(options.queuedMessages ?? []).map(
                  (queued) => queued.message.id,
                ),
                preparedState.userMessageId,
              ]),
            ],
            surface: options.execution?.surface ?? "slack",
            turnId,
          });
        }
        if (conversationId) {
          const turnStartedAtMs = message.metadata.dateSent.getTime();
          // Fire-and-forget: both calls are best-effort and must not delay
          // reply generation. Keep them independent so a failure in one does
          // not suppress observability of the other.
          void recordTurnSummary({
            channelName,
            conversationId,
            turnId: turnId,
            sliceId: 1,
            startedAtMs: turnStartedAtMs,
            state: "running",
            surface: options.execution?.surface ?? "slack",
            dispatchId: options.execution?.dispatch?.id,
            actor: executionActor,
            destination,
            destinationVisibility,
            source,
            traceId: getActiveTraceId(),
          }).catch((error) => {
            logException(error, "agent.turn.summary_record.failed", {
              "app.agent.turn.state": "running",
            });
          });
        }
        setTags({
          conversationId,
        });
        if (shouldEmitDevAgentTrace()) {
          logInfo("agent.turn.started", {
            "app.message.id": message.id,
            ...(messageTs ? { "messaging.message.id": messageTs } : undefined),
          });
        }
        await persistThreadState(thread, {
          conversation: preparedState.conversation,
        });
        await options.onTurnStatePersisted?.();

        if (actor) {
          setSentryUser({
            id: actor.userId,
            ...(actor.userName ? { username: actor.userName } : undefined),
            ...(actor.email ? { email: actor.email } : undefined),
          });
        }
        if (actor?.userName) {
          setTags({ userName: actor.userName });
        }
        const turnAttachments = collectAttachments(
          message,
          options.queuedMessages,
        );
        const userAttachments = await deps.resolveUserAttachments(
          turnAttachments,
          {
            threadId,
            actorId: slackActorId,
            channelId,
            runId,
            conversation: preparedState.conversation,
            messageTs: slackMessageTs,
          },
        );
        const omittedImageAttachmentCount =
          !isVisionEnabled() && hasPotentialImageAttachment(turnAttachments)
            ? countPotentialImageAttachments(turnAttachments)
            : 0;
        const status = createSlackAdapterAssistantStatusSession({
          channelId: assistantThreadContext?.channelId,
          threadTs: assistantThreadContext?.threadTs,
          getSlackAdapter: deps.getSlackAdapter,
        });
        const compactingStatus: AssistantStatusSpec = {
          text: "Compacting context",
        };
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;
        // Once model output is settled, later commit errors must not trigger a
        // second visible failure reply.
        let runResultHandled = false;
        let assistantMessageDelivered = false;
        let acceptedDeliveryId: string | undefined;
        let turnCompletionNotified = false;
        const recordDispatchOutcome = async (
          dispatchOutcome: "blocked" | "completed" | "failed",
          state: "completed" | "failed",
        ): Promise<void> => {
          const dispatchId = options.execution?.dispatch?.id;
          if (!dispatchId) {
            return;
          }
          await recordTurnSummary({
            channelName,
            conversationId,
            destination,
            destinationVisibility,
            dispatchId,
            dispatchOutcome,
            ...(acceptedDeliveryId
              ? { resultMessageId: acceptedDeliveryId }
              : undefined),
            turnId: turnId,
            sliceId: 1,
            source,
            startedAtMs: message.metadata.dateSent.getTime(),
            state,
            surface: options.execution?.surface ?? "slack",
          });
        };
        let turnWakeError: unknown;
        let boundaryFailureCode: "agent_run_failed" | "delivery_failed" =
          "agent_run_failed";
        let terminalDispatchFailureOutcome: "blocked" | undefined;
        const notifyTurnCompleted = async (): Promise<void> => {
          if (turnCompletionNotified) {
            return;
          }
          await options.onTurnCompleted?.();
          turnCompletionNotified = true;
        };
        /** Post and record one completed assistant message in the active thread. */
        const deliverAssistantMessage = async (
          reply: AssistantMessage | string,
          terminalDispatchOutcome?: "blocked" | "failed",
        ): Promise<void> => {
          const agentMessage = typeof reply === "string" ? undefined : reply;
          const text =
            typeof reply === "string" ? reply : getAssistantReplyText(reply);
          if (!text?.trim()) {
            return;
          }
          boundaryFailureCode = "delivery_failed";
          let slackMessageTs: string[] = [];
          // Prep runs outside the post try/catch so non-Slack failures are not
          // classified as retryable delivery errors.
          await beforeFirstResponsePost();
          try {
            if (shouldPublishExternally(options.publishExternally)) {
              if (channelId && thread.adapter.name === "slack") {
                slackMessageTs = await sendSlackReply({
                  channelId,
                  conversationId,
                  replyAttribution:
                    options.execution?.dispatch?.replyAttribution,
                  text,
                  ...(threadTs ? { threadTs } : undefined),
                });
              } else {
                for (const part of splitSlackReplyText(text)) {
                  const postedMessageTs = (
                    await thread.post(buildSlackOutputMessage(part))
                  ).id;
                  if (postedMessageTs) {
                    slackMessageTs.push(postedMessageTs);
                  }
                }
              }
            }
          } catch (error) {
            if (isRetryableSlackPostError(error)) {
              throw new RetryableDeliveryError(error);
            }
            const eventId = logException(error, "slack.thread.post.failed", {
              "app.slack.reply_stage": "thread_reply",
              ...(messageTs
                ? { "messaging.message.id": messageTs }
                : undefined),
              ...getSlackErrorObservabilityAttributes(error),
            });
            throw new ConversationTurnBoundaryError({
              cause: error,
              ...(eventId ? { eventId } : undefined),
              failureCode: "delivery_failed",
            });
          }
          const slackTs = slackMessageTs.at(-1);
          assistantMessageDelivered = true;
          acceptedDeliveryId = slackTs;
          options.onTurnDeliveryAccepted?.(slackTs);
          const recordedMessageId = recordDeliveredAssistantMessage({
            conversation: preparedState.conversation,
            sessionId: turnId,
            source: "slack",
            text,
            userMessageId: preparedState.userMessageId,
          });
          if (slackTs) {
            markConversationMessage(
              preparedState.conversation,
              recordedMessageId,
              { slackTs },
            );
          }
          try {
            const providerConversationIds = threadTs
              ? [threadTs]
              : slackMessageTs;
            await persistWithRetry(() =>
              commitAcceptedReply({
                ...(agentMessage ? { agentMessage } : undefined),
                conversation: preparedState.conversation,
                conversationMessageId: recordedMessageId,
                conversationId,
                ...(options.execution?.dispatch &&
                providerConversationIds.length > 0
                  ? {
                      providerConversationBindings: providerConversationIds.map(
                        (providerConversationId) => ({
                          provider: "slack",
                          providerDestinationId: destination.channelId,
                          providerTenantId: destination.teamId,
                          providerConversationId,
                        }),
                      ),
                    }
                  : undefined),
              }),
            );
            await options.onTurnStatePersisted?.();
          } catch (error) {
            logException(
              new Error("Accepted assistant message persistence failed"),
              "slack.assistant.message_post_delivery_persist.failed",
              {
                "error.type":
                  error instanceof Error ? error.name : typeof error,
              },
            );
          }
          if (slackTs && options.execution?.dispatch?.id) {
            try {
              await persistWithRetry(() =>
                recordTurnSummary({
                  channelName,
                  conversationId,
                  destination,
                  destinationVisibility,
                  dispatchId: options.execution?.dispatch?.id,
                  resultMessageId: slackTs,
                  turnId: turnId,
                  sliceId: 1,
                  source,
                  startedAtMs: message.metadata.dateSent.getTime(),
                  ...(terminalDispatchOutcome
                    ? { dispatchOutcome: terminalDispatchOutcome }
                    : undefined),
                  state: terminalDispatchOutcome ? "failed" : "running",
                  surface: options.execution?.surface ?? "slack",
                }),
              );
            } catch (error) {
              logException(error, "agent.turn.delivery_receipt_persist.failed");
            }
          }
          boundaryFailureCode = "agent_run_failed";
        };

        try {
          const loadedPiMessages = await loadPiMessagesForTurn({
            conversationId,
            activeTurnId,
          });
          let piMessages = loadedPiMessages.piMessages;
          if (
            conversationId &&
            loadedPiMessages.canCompact &&
            piMessages?.length
          ) {
            const compaction =
              await deps.services.contextCompactor.maybeCompact({
                conversation: preparedState.conversation,
                conversationContext: preparedState.conversationContext,
                conversationId,
                metadata: {
                  threadId,
                  actorId: slackActorId,
                  channelId,
                  runId,
                },
                onCompactionStart: () => status.update(compactingStatus),
                piMessages,
                modelId: modelIdForProfile(
                  botConfig,
                  loadedPiMessages.modelProfile ?? botConfig.defaultProfile,
                ),
              });
            if (compaction.compacted) {
              piMessages = compaction.piMessages;
              await persistThreadState(thread, {
                conversation: preparedState.conversation,
              });
            }
          }
          const hasDurablePromptHistory = Boolean(piMessages?.length);
          // Each batched steering message keeps its own Actor and authority.
          const batchedSteeringMessages = (
            await resolveSteeringMessages(
              (options.queuedMessages ?? []).filter(
                (queued) => queued.explicitMention,
              ),
            )
          ).map((steering) => ({
            message: buildSteeringPiMessage(steering),
            provenance: steering.provenance,
          }));
          // Save the batch before starting the Run so every Actor stays attached
          // to the right instruction. The first Turn checkpoint can then reuse
          // that saved history.
          if (
            !(await saveSteeringMessages({
              conversationId,
              messages: batchedSteeringMessages,
            }))
          ) {
            // A resumed Run is saving the same history. Keep this mailbox
            // delivery pending and do not start without the saved messages.
            shouldPersistFailureState = false;
            throw new TurnInputDeferredError();
          }
          if (batchedSteeringMessages.length > 0) {
            // A repeated mailbox delivery may reload saved steering messages.
            // Add only messages that are not already in agent history.
            const presentKeys = new Set(
              (piMessages ?? [])
                .map(steeringMessageKey)
                .filter((key): key is string => key !== undefined),
            );
            const newSteeringMessages = batchedSteeringMessages
              .map((entry) => entry.message)
              .filter((batchedMessage) => {
                const key = steeringMessageKey(batchedMessage);
                return key === undefined || !presentKeys.has(key);
              });
            if (newSteeringMessages.length > 0) {
              piMessages = [...(piMessages ?? []), ...newSteeringMessages];
            }
          }

          status.update();
          // Title generation is automatic on transcript persist. DM threads only
          // project the stored/in-flight title to Slack once it settles.
          void resolveConversationTitle({ conversationId })
            .then(async (title) => {
              if (!title) {
                return;
              }
              await maybeSyncAssistantTitle({
                channelId: assistantThreadContext?.channelId,
                getSlackAdapter: deps.getSlackAdapter,
                threadTs: assistantThreadContext?.threadTs,
                title,
              });
            })
            .catch((error) => {
              logException(error, "conversation.title.task.failed");
            });
          const toolChannelId = channelId;
          const activeInstructionAuthorId =
            actor?.userId ?? parseActorUserId(message.author.userId);
          const activeInstructionAuthorName =
            actor?.fullName ?? actor?.userName;
          const promptConversationContext = appendRecentMessagesToContext(
            preparedState.conversationContext,
            options.queuedMessages ?? [],
          );
          const drainSteeringMessages = options.drainSteeringMessages
            ? async (
                accept: (messages: AgentSteeringMessage[]) => Promise<void>,
              ): Promise<AgentSteeringMessage[]> => {
                let acceptedMessages: AgentSteeringMessage[] | undefined;
                const drained = await options.drainSteeringMessages!(
                  async (queuedMessages) => {
                    acceptedMessages =
                      await resolveSteeringMessages(queuedMessages);
                    await accept(acceptedMessages);
                  },
                  { conversationContext: preparedState.conversationContext },
                );
                return (
                  acceptedMessages ?? (await resolveSteeringMessages(drained))
                );
              }
            : undefined;
          const run: AgentRun = {
            conversationId,
            turnId,
            ...(runId ? { runId } : undefined),
            instruction: {
              actor: {
                ...(activeInstructionAuthorId
                  ? { authorId: activeInstructionAuthorId }
                  : undefined),
                ...(activeInstructionAuthorName
                  ? { authorName: activeInstructionAuthorName }
                  : undefined),
                ...(slackMessageTs ? { slackTs: slackMessageTs } : undefined),
              },
              includeConversationContextWithHistory: hasDurablePromptHistory,
              text: effectiveUserText,
              context: promptConversationContext,
              inboundAttachmentCount: turnAttachments.length,
              omittedImageAttachmentCount,
              attachments: userAttachments,
            },
            history: piMessages,
            credentialContext,
            // Always set the execution actor when known. Resource-event turns
            // carry the system principal; interactive turns carry the Slack user.
            actor: executionActor,
            slackConversation,
            source,
            destination,
            publishExternally: shouldPublishExternally(
              options.publishExternally,
            ),
            ...(destinationVisibility ? { destinationVisibility } : undefined),
            surface: options.execution?.surface ?? "slack",
            dispatch: options.execution?.dispatch,
            toolChannelId,
            slackActionToken,
            environment: {
              configuration: preparedState.configuration,
              locationConfiguration: preparedState.locationConfiguration,
            },
            disabledFeatures:
              options.execution?.disabledFeatures ??
              (message.author.isBot === true
                ? (["interactive-auth"] as const)
                : undefined),
            deadlineAtMs: getTurnRequestDeadline()?.deadlineAtMs,
            state: {
              pendingAuth: preparedState.conversation.processing.pendingAuth,
              sandboxRef: preparedState.sandboxRef,
            },
            onEvent: async (event) => {
              if (event.type === "status") {
                status.update({ text: event.text });
                return;
              }
              if (event.type === "tool_started") {
                await options.onToolInvocation?.({
                  params: event.params,
                  toolName: event.toolName,
                });
              }
            },
            delivery: deliverAssistantMessage,
            durability: {
              onInputCommitted: options.ack,
              drainSteeringMessages,
              shouldYield: options.shouldYield,
              onSandboxRefChanged: async (sandboxRef) => {
                await persistThreadState(thread, {
                  sandboxRef,
                });
              },
              recordPendingAuth: async (pendingAuth) => {
                preparedState.conversation.processing.pendingAuth = pendingAuth;
                await persistThreadState(thread, {
                  conversation: preparedState.conversation,
                });
              },
            },
          };
          let completedResult: AgentRunResult | undefined;
          const saveResult = async (result: AgentRunResult) => {
            let finalResult = result;
            setTags({ modelId: finalResult.diagnostics.modelId });
            const diagnosticsAttributes =
              getAgentTurnDiagnosticsAttributes(finalResult);
            setSpanAttributes(diagnosticsAttributes);
            let failureEventId: string | undefined;
            if (finalResult.diagnostics.outcome !== "success") {
              const finalized = finalizeFailedTurnReplyWithEvent({
                reply: finalResult,
                logException,
              });
              finalResult = finalized.reply;
              failureEventId = finalized.eventId;
              await deliverAssistantMessage(finalResult.text);
            }
            const turnResult: DispatchTurnResult =
              finalResult.diagnostics.outcome === "success"
                ? { outcome: "completed" }
                : {
                    errorMessage:
                      finalResult.diagnostics.errorMessage ??
                      `Agent turn ended with ${finalResult.diagnostics.outcome}.`,
                    outcome: "failed",
                  };
            runResultHandled = true;
            shouldPersistFailureState = false;
            boundaryFailureCode = "agent_run_failed";

            const completedState = buildDeliveredTurnStatePatch({
              conversation: preparedState.conversation,
              reply: finalResult,
              sessionId: turnId,
              userMessageId: preparedState.userMessageId,
            });
            let saveFailed = false;
            let saveFailureEventId: string | undefined;
            try {
              // Save the accepted delivery first so recovery cannot send the
              // reply again. Save Conversation messages next and Redis state
              // last.
              if (conversationId && finalResult.piMessages?.length) {
                await saveTurnCheckpoint({
                  mode: "completed",
                  channelName,
                  conversationId,
                  turnId,
                  durationMs: finalResult.diagnostics.durationMs,
                  usage: finalResult.diagnostics.usage,
                  destination,
                  destinationVisibility,
                  source,
                  sliceId: 1,
                  dispatchOutcome:
                    finalResult.diagnostics.outcome === "success"
                      ? "completed"
                      : "failed",
                  ...(options.execution?.dispatch && turnResult.errorMessage
                    ? { errorMessage: turnResult.errorMessage }
                    : undefined),
                  ...(acceptedDeliveryId
                    ? { resultMessageId: acceptedDeliveryId }
                    : undefined),
                  messages: finalResult.piMessages,
                  actor: executionActor,
                  surface: options.execution?.surface ?? "slack",
                  dispatchId: options.execution?.dispatch?.id,
                });
              } else if (conversationId) {
                await recordTurnSummary({
                  channelName,
                  conversationId,
                  cumulativeDurationMs: finalResult.diagnostics.durationMs,
                  cumulativeUsage: finalResult.diagnostics.usage,
                  turnId,
                  sliceId: 1,
                  startedAtMs: message.metadata.dateSent.getTime(),
                  state: "completed",
                  actor: executionActor,
                  destination,
                  destinationVisibility,
                  source,
                  surface: options.execution?.surface ?? "slack",
                  dispatchId: options.execution?.dispatch?.id,
                  dispatchOutcome:
                    finalResult.diagnostics.outcome === "success"
                      ? "completed"
                      : "failed",
                  ...(acceptedDeliveryId
                    ? { resultMessageId: acceptedDeliveryId }
                    : undefined),
                  traceId: getActiveTraceId(),
                });
              }
              await persistWithRetry(() =>
                persistConversationMessages({
                  conversation: completedState.conversation,
                  conversationId,
                }),
              );
              await persistThreadRuntimeStateWithRetry(thread, completedState);
            } catch (saveError) {
              // The user already saw the reply. Record the save failure without
              // posting a second error reply.
              saveFailed = true;
              saveFailureEventId = logException(
                saveError,
                "slack.reply.post_delivery_commit.failed",
                messageTs ? { "messaging.message.id": messageTs } : {},
              );
            }
            preparedState.conversation = completedState.conversation;
            persistedAtLeastOnce = true;
            options.onTurnOutcome?.(turnResult);
            completedResult = finalResult;

            if (saveFailed) {
              return {
                ...(saveFailureEventId
                  ? { eventId: saveFailureEventId }
                  : undefined),
                failureCode: "persistence_failed" as const,
                outcome: "failed" as const,
              };
            }
            if (finalResult.diagnostics.outcome === "success") {
              return {
                outcome: assistantMessageDelivered
                  ? ("success" as const)
                  : ("no_reply" as const),
              };
            }
            return {
              ...(failureEventId ? { eventId: failureEventId } : undefined),
              failureCode: "model_execution_failed" as const,
              outcome: "failed" as const,
            };
          };
          const outcome = await deps.executeTurn(run, saveResult);
          if (outcome.status === "awaiting_auth") {
            await recordDispatchOutcome("blocked", "failed");
            options.onTurnOutcome?.({ outcome: "blocked" });
            if (!actor) {
              const authFailureEventId = logException(
                new Error(
                  `Subscribed Slack turn requires ${outcome.providerDisplayName} authorization`,
                ),
                "subscribed_message.authorization.required",
                { "app.ai.failure_code": "agent_run_failed" },
              );
              const text = `I could not act on this subscribed event because ${outcome.providerDisplayName} needs user authorization. Ask me in this thread to connect ${outcome.providerDisplayName} before retrying.`;
              await deliverAssistantMessage(text);
              markTurnClosed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: turnId,
              });
              await persistThreadState(thread, {
                conversation: preparedState.conversation,
              });
              if (conversationId) {
                await deps.services.turnLifecycle.fail({
                  conversationId,
                  createdAtMs: Date.now(),
                  ...(authFailureEventId
                    ? { eventId: authFailureEventId }
                    : undefined),
                  failureCode: "agent_run_failed",
                  turnId,
                });
              }
              persistedAtLeastOnce = true;
              shouldPersistFailureState = false;
              return;
            }
            await postAuthPauseNotice(
              outcome.providerDisplayName,
              outcome.requestText,
            );
            completeAuthPauseTurn({
              conversation: preparedState.conversation,
              sessionId: turnId,
            });
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            persistedAtLeastOnce = true;
            shouldPersistFailureState = false;
            return;
          }
          if (outcome.status === "suspended") {
            options.onTurnOutcome?.({ outcome: "awaiting_resume" });
            // Soft yield follows shouldYield(). Hard timeout under a worker that
            // can hand the lease back also yields so the next wake gets a full
            // host budget. Live webhook paths have no shouldYield and schedule a
            // wake instead.
            if (
              options.shouldYield &&
              (options.shouldYield() || outcome.reason === "timeout")
            ) {
              shouldPersistFailureState = false;
              throw new CooperativeTurnYieldError();
            }
            if (!destination || !conversationId) {
              throw new Error(
                "Paused turn requires a destination and conversation id",
              );
            }
            try {
              await deps.services.wakePausedTurn({
                conversationId,
                destination,
                turnId: turnId,
                expectedVersion: outcome.resumeVersion,
              });
              shouldPersistFailureState = false;
            } catch (scheduleError) {
              logException(scheduleError, "agent.continue.schedule.failed", {
                ...(messageTs
                  ? { "messaging.message.id": messageTs }
                  : undefined),
                "app.ai.resume_session_version": outcome.resumeVersion,
              });
              shouldPersistFailureState = true;
              turnWakeError = scheduleError;
              throw scheduleError;
            }
            return;
          }

          if (!completedResult) {
            throw new Error("Completed Turn did not save a result");
          }
          if (shouldEmitDevAgentTrace()) {
            logInfo("agent.turn.completed", {
              "app.ai.outcome": completedResult.diagnostics.outcome,
              "app.ai.tool_call_count":
                completedResult.diagnostics.toolCalls.length,
              "app.ai.tool_error_results":
                completedResult.diagnostics.toolErrorCount,
            });
          }
          await notifyTurnCompleted();
          if (
            completedResult.diagnostics.outcome === "success" &&
            conversationId
          ) {
            try {
              await deps.services.scheduleSessionCompletedPluginTasks({
                conversationId,
                sessionId: turnId,
              });
            } catch (error) {
              logException(
                error,
                "plugin.session.completed_task_schedule.failed",
              );
            }
          }
        } catch (error) {
          if (runResultHandled) {
            // Errors after the completed run produced output or intentional
            // silence (redundant-ack cleanup, completion callbacks) must not
            // fail the turn or trigger the visible failure fallback.
            // Still mark the turn completed so processing reactions run the
            // complete lifecycle (remove thinking + add done), including for
            // reaction-only / no-reply turns with no thread post.
            shouldPersistFailureState = false;
            logException(
              error,
              "slack.reply.post_delivery_commit.failed",
              messageTs ? { "messaging.message.id": messageTs } : {},
            );
            try {
              await notifyTurnCompleted();
            } catch (completionError) {
              logException(
                completionError,
                "slack.reply.post_delivery_completion_callback.failed",
                messageTs ? { "messaging.message.id": messageTs } : {},
              );
            }
            return;
          }
          if (error instanceof CooperativeTurnYieldError) {
            shouldPersistFailureState = false;
            throw error;
          }
          if (error instanceof TurnInputDeferredError) {
            shouldPersistFailureState = false;
            throw error;
          }
          if (error === turnWakeError) {
            shouldPersistFailureState = true;
          }
          shouldPersistFailureState = true;
          const runFailure =
            error instanceof AgentRunError ? error.cause : error;
          const classifiedFailure =
            getConversationTurnBoundaryError(runFailure);
          const failureCause = classifiedFailure?.cause ?? runFailure;
          if (
            failureCause instanceof AuthorizationFlowDisabledError ||
            failureCause instanceof PluginCredentialFailureError
          ) {
            terminalDispatchFailureOutcome = "blocked";
          }
          const failureCode =
            classifiedFailure?.failureCode ?? boundaryFailureCode;
          const failureEventId =
            classifiedFailure?.eventId ??
            logException(failureCause, "slack.turn.execution.failed", {
              "app.ai.failure_code": failureCode,
            });
          throw new ConversationTurnBoundaryError({
            cause: failureCause,
            ...(failureEventId ? { eventId: failureEventId } : undefined),
            failureCode,
          });
        } finally {
          if (!persistedAtLeastOnce && shouldPersistFailureState) {
            markTurnFailed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              sessionId: turnId,
              userMessageId: preparedState.userMessageId,
              markConversationMessage: (conversation, messageId, patch) => {
                markConversationMessage(conversation, messageId, patch);
              },
            });
            if (conversationId) {
              try {
                await recordTurnSummary({
                  channelName,
                  conversationId,
                  turnId: turnId,
                  sliceId: 1,
                  startedAtMs: message.metadata.dateSent.getTime(),
                  state: "failed",
                  actor,
                  destination,
                  destinationVisibility,
                  source,
                  surface: options.execution?.surface ?? "slack",
                  dispatchId: options.execution?.dispatch?.id,
                  ...(options.execution?.dispatch &&
                  terminalDispatchFailureOutcome
                    ? {
                        dispatchOutcome: terminalDispatchFailureOutcome,
                      }
                    : undefined),
                  traceId: getActiveTraceId(),
                });
                const sessionRecord = await getTurnRecord(
                  conversationId,
                  turnId,
                );
                if (sessionRecord) {
                  await failTurnRecord({
                    conversationId,
                    expectedVersion: sessionRecord.version,
                    turnId: turnId,
                    errorMessage:
                      "Agent turn failed before assistant output handling completed",
                  });
                }
              } catch (recordError) {
                logException(
                  recordError,
                  "agent.turn.failed_session_record_persist.failed",
                );
              }
            }
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            if (shouldEmitDevAgentTrace()) {
              logWarn("agent.turn.failed");
            }
          }
          await status.clear();
        }
      },
    );
  };
}
