/**
 * Slack reply execution boundary.
 *
 * This module bridges prepared Slack thread state into the agent runner
 * and commits the resulting Slack-visible delivery/state updates. It is where
 * queued messages, compaction, status updates, and Slack posting meet; agent
 * internals stay behind the runner seam.
 */
import type { Message, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import {
  modelIdForProfile,
  STANDARD_MODEL_PROFILE,
  standardModelId,
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
  type AgentRunSteeringMessage,
} from "@/chat/agent/request";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
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
  type ConversationMemoryService,
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
import { maybeUpdateAssistantTitle } from "@/chat/slack/assistant-thread/title";
import {
  conversationVisibilityFromSlackChannelType,
  resolveSlackChannelTypeFromMessage,
  resolveSlackConversationContext,
} from "@/chat/slack/conversation-context";
import { lookupSlackUser } from "@/chat/slack/user";
import { createActor, parseActorUserId, type Actor } from "@/chat/actor";
import {
  ensureSlackMessageActorIdentity,
  getMessageActorIdentity,
} from "@/chat/services/message-actor-identity";
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
import { getConversationStore } from "@/chat/db";
import {
  contextProvenance,
  instructionProvenanceFor,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  commitAcceptedReply,
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { persistWithRetry } from "@/chat/services/persist-retry";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { requireSlackDestination } from "@/chat/destination";
import { escapeXml } from "@/chat/xml";
import { persistConversationMessages } from "@/chat/conversations/messages";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import type {
  DispatchTurnContext,
  DispatchTurnResult,
} from "@/chat/agent-dispatch/types";

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

/**
 * Identity key for parked-input dedupe: the inbound timestamp plus the user
 * turn text (always the first content part). Attachment resolution may differ
 * across queue redeliveries, so resolved attachment parts must not decide
 * whether the same inbound message was already appended.
 */
function parkedInputKey(message: PiMessage): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  const first = Array.isArray(message.content) ? message.content[0] : undefined;
  const text =
    first && typeof first === "object" && "text" in first
      ? String((first as { text?: unknown }).text ?? "")
      : "";
  return `${message.timestamp}:${text}`;
}

function renderRecentThreadMessages(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
): string | undefined {
  const passiveMessages = messages.filter((queued) => {
    if (queued.explicitMention) {
      return false;
    }
    const slackTs = queuedInstructionActor(queued)?.slackTs;
    return !slackTs || !conversationContext?.includes(`slack_ts="${slackTs}"`);
  });
  if (passiveMessages.length === 0) {
    return undefined;
  }
  const lines = ["<recent-thread-messages>"];
  for (const queued of passiveMessages) {
    const actor = queuedInstructionActor(queued);
    const attrs = [
      actor?.authorId ? `author_id="${escapeXml(actor.authorId)}"` : undefined,
      actor?.authorName
        ? `author_name="${escapeXml(actor.authorName)}"`
        : undefined,
      actor?.slackTs ? `slack_ts="${escapeXml(actor.slackTs)}"` : undefined,
    ]
      .filter((attr): attr is string => Boolean(attr))
      .join(" ");
    lines.push(
      attrs ? `  <message ${attrs}>` : "  <message>",
      escapeXml(queued.userText),
      "  </message>",
    );
  }
  lines.push("</recent-thread-messages>");
  return lines.join("\n");
}

function appendRecentThreadMessagesToContext(
  conversationContext: string | undefined,
  messages: QueuedTurnMessage[],
  options?: { includeConversationContext?: boolean },
): string | undefined {
  const recentThreadMessages = renderRecentThreadMessages(
    conversationContext,
    messages,
  );
  const contextParts = [
    options?.includeConversationContext === false
      ? undefined
      : conversationContext?.trim(),
    recentThreadMessages,
  ].filter((part): part is string => Boolean(part));
  return contextParts.length > 0 ? contextParts.join("\n\n") : undefined;
}

function queuedInstructionActor(
  queued: QueuedTurnMessage,
): AgentRunSteeringMessage["actor"] {
  const actor = getMessageActorIdentity(queued.message);
  const authorId =
    actor?.userId ?? parseActorUserId(queued.message.author.userId);
  const authorName = actor?.fullName ?? actor?.userName;
  const slackTs = getMessageTimestamp(queued.message);
  return {
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(slackTs ? { slackTs } : {}),
  };
}

/**
 * Provenance for a queued or steered Slack message: a user-authored instruction
 * attributed to the message's own author, or unauthored context for
 * system-originated resource events.
 */
function queuedInstructionProvenance(
  queued: QueuedTurnMessage,
  teamId: string,
): ConversationMessageProvenance {
  if (isResourceEventSlackMessage(queued.message)) {
    return contextProvenance;
  }
  const identity = getMessageActorIdentity(queued.message);
  const author =
    identity && "platform" in identity
      ? identity
      : createActor(
          { userId: parseActorUserId(queued.message.author.userId) },
          {
            platform: "slack",
            teamId,
            userId: parseActorUserId(queued.message.author.userId),
          },
        );
  return instructionProvenanceFor(author);
}

async function resolveChannelName(thread: Thread): Promise<string | undefined> {
  const existingName = thread.channel.name?.trim();
  if (existingName) {
    return existingName;
  }

  try {
    const metadata = await thread.channel.fetchMetadata();
    return metadata.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function collectTurnAttachments(
  message: Message,
  queuedMessages?: QueuedTurnMessage[],
): Message["attachments"] {
  return [
    ...(queuedMessages ?? []).flatMap((queued) => queued.message.attachments),
    ...message.attachments,
  ];
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

export interface ReplyExecutorServices {
  agentRunner: AgentRunner;
  contextCompactor: ContextCompactor;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
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

interface ReplyExecutorDeps {
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
  services: ReplyExecutorServices;
}

/** Build the shared reply handler that prepares, advances, and commits a turn. */
/** Slack reply executor publishes unless a caller opts out. */
function shouldPublishExternally(publishExternally?: boolean): boolean {
  return publishExternally !== false;
}

export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
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
        modelId: standardModelId(botConfig),
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
              ...(messageTs ? { "messaging.message.id": messageTs } : {}),
              ...getSlackErrorObservabilityAttributes(error),
            });
          }
        };
        let activeTurnId = preparedState.conversation.processing.activeTurnId;
        const resolveSteeringMessages = async (
          queuedMessages: QueuedTurnMessage[],
        ): Promise<AgentRunSteeringMessage[]> => {
          return await Promise.all(
            queuedMessages.map(async (queued) => {
              const attachments = queued.message.attachments;
              return {
                actor: queuedInstructionActor(queued),
                provenance: queuedInstructionProvenance(queued, teamId),
                text: queued.userText,
                timestampMs: queued.message.metadata.dateSent.getTime(),
                omittedImageAttachmentCount:
                  !isVisionEnabled() && hasPotentialImageAttachment(attachments)
                    ? countPotentialImageAttachments(attachments)
                    : 0,
                userAttachments: await deps.resolveUserAttachments(
                  attachments,
                  {
                    threadId,
                    actorId: isResourceEventSlackMessage(queued.message)
                      ? undefined
                      : queued.message.author.userId,
                    channelId,
                    runId,
                    conversation: preparedState.conversation,
                    messageTs: getMessageTimestamp(queued.message),
                  },
                ),
              };
            }),
          );
        };
        /**
         * Commit drained parked/batched input pairs to the conversation
         * event log, deduping by `parkedInputKey` so a redelivery never
         * double-appends. This is the Membership-Rule commit point
         * Membership rule: each drained message is written with its
         * own author's instruction provenance while that author is still known,
         * rather than collapsing to a single latest-wins actor.
         *
         * The read-compute-append races a concurrently-resumed slice, which
         * runs under the thread resume lock; take the same lock so the two
         * writers never interleave. Returns false when the lock is busy (a live
         * resume owns the event log): the caller must leave the mailbox
         * message pending for the next drain instead of consuming it.
         */
        const drainParkedInputToEventLog = async (
          pairs: Array<{
            message: PiMessage;
            provenance: ConversationMessageProvenance;
          }>,
        ): Promise<boolean> => {
          if (!conversationId || pairs.length === 0) {
            return true;
          }
          const stateAdapter = getStateAdapter();
          await stateAdapter.connect();
          const lock = await acquireActiveLock(stateAdapter, conversationId);
          if (!lock) {
            return false;
          }
          try {
            const projection = await loadConversationProjection({
              conversationId,
            });
            // Dedupe per message: a partial-overlap redelivery (some messages
            // already appended before a schedule failure) must append only
            // the missing ones.
            const appendedKeys = new Set(
              projection.messages
                .map(parkedInputKey)
                .filter((key): key is string => key !== undefined),
            );
            const missing = pairs.filter((pair) => {
              const key = parkedInputKey(pair.message);
              return key === undefined || !appendedKeys.has(key);
            });
            if (missing.length === 0) {
              // A prior delivery already appended this input durably.
              return true;
            }
            await commitMessages({
              conversationId,
              messages: [
                ...projection.messages,
                ...missing.map((pair) => pair.message),
              ],
              provenance: [
                ...projection.provenance,
                ...missing.map((pair) => pair.provenance),
              ],
            });
            return true;
          } finally {
            await stateAdapter.releaseLock(lock);
          }
        };
        /**
         * Durably append this turn's parked user input to the event log at
         * the parked safe boundary so the resumed `continue()` sees it. The
         * awaiting record pins the log session and materializes the projection
         * tail, so the append needs no record mutation. Must complete before
         * `ack` consumes the mailbox record.
         */
        const appendParkedTurnInput = async (
          parkedSessionId: string,
        ): Promise<boolean> => {
          if (!conversationId) {
            return true;
          }
          const parkedMessages = [
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
            // Redelivery of the parked turn's own message must not duplicate
            // the prompt that already started the session.
            (queued) =>
              buildDeterministicTurnId(queued.message.id) !== parkedSessionId,
          );
          if (parkedMessages.length === 0) {
            return true;
          }
          const parkedPairs = (
            await resolveSteeringMessages(parkedMessages)
          ).map((steering) => ({
            message: buildSteeringPiMessage(steering),
            provenance: steering.provenance,
          }));
          return drainParkedInputToEventLog(parkedPairs);
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
            // Durable event-log append first: rescheduling a continuation
            // does not consume the message, and `ack` may only
            // fire after the input is model-visible.
            if (!(await appendParkedTurnInput(pausedTurn.turnId))) {
              // A live resume holds the thread lock; leave the mailbox
              // message pending so the next drain re-delivers it after the
              // resume completes.
              throw new TurnInputDeferredError();
            }
            try {
              await deps.services.wakePausedTurn(pausedTurn);
            } catch (error) {
              logException(error, "agent.continue.schedule.failed", {
                "app.ai.resume_session_version": pausedTurn.expectedVersion,
                "app.ai.resume_session_id": pausedTurn.turnId,
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
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
              // A user follow-up supersedes the auth-parked run: answer it
              // now as a fresh turn instead of consuming it into a pause that
              // may never resume. The parked prompt stays model-visible via
              // the event-log projection, pendingAuth state keeps the
              // authorization link reusable, and the abandoned record turns a
              // late OAuth callback into a stale no-op instead of a competing
              // run.
              await abandonTurnRecord({
                conversationId,
                turnId: activeTurnId,
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
            ...(messageTs ? { "messaging.message.id": messageTs } : {}),
          });
        }
        await persistThreadState(thread, {
          conversation: preparedState.conversation,
        });
        await options.onTurnStatePersisted?.();

        if (actor) {
          setSentryUser({
            id: actor.userId,
            ...(actor.userName ? { username: actor.userName } : {}),
            ...(actor.email ? { email: actor.email } : {}),
          });
        }
        if (actor?.userName) {
          setTags({ userName: actor.userName });
        }
        const turnAttachments = collectTurnAttachments(
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
        let lifecycleTerminalized = false;
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
              : {}),
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
        let finalizedFailureEventId: string | undefined;
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
                  replyAttribution: options.execution?.dispatch?.replyAttribution,
                  text,
                  ...(threadTs ? { threadTs } : {}),
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
              ...(messageTs ? { "messaging.message.id": messageTs } : {}),
              ...getSlackErrorObservabilityAttributes(error),
            });
            throw new ConversationTurnBoundaryError({
              cause: error,
              ...(eventId ? { eventId } : {}),
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
                ...(agentMessage ? { agentMessage } : {}),
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
                  : {}),
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
                    : {}),
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
                  loadedPiMessages.modelProfile ?? STANDARD_MODEL_PROFILE,
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
          // Batched parked input: each explicit-mention message another actor
          // sent before this turn started, drained into it, kept with its own
          // author's provenance so every contributor joins the run's actors.
          const batchedInstructions = (
            await resolveSteeringMessages(
              (options.queuedMessages ?? []).filter(
                (queued) => queued.explicitMention,
              ),
            )
          ).map((steering) => ({
            message: buildSteeringPiMessage(steering),
            provenance: steering.provenance,
          }));
          // Commit the batch to the event log before the run starts — the
          // Membership-rule commit point — so its
          // authors' instruction provenance is durable while they are known.
          // The fresh prompt checkpoint then matches these merged messages as
          // an already-committed prefix and reuses that provenance instead of
          // collapsing them to the live actor.
          if (!(await drainParkedInputToEventLog(batchedInstructions))) {
            // A live resume owns the event-log read-modify-write. Defer the
            // turn (as appendParkedTurnInput does) so the worker releases the
            // lease and the next drain commits provenance before running;
            // never run with the batch uncommitted.
            shouldPersistFailureState = false;
            throw new TurnInputDeferredError();
          }
          if (batchedInstructions.length > 0) {
            // Merge the committed batch into the transcript the model sees. A
            // redelivery reloads the batch from the durable log, so skip any
            // message already present by `parkedInputKey` — never merge (and
            // later re-commit) the same batched message twice.
            const presentKeys = new Set(
              (piMessages ?? [])
                .map(parkedInputKey)
                .filter((key): key is string => key !== undefined),
            );
            const newlyBatched = batchedInstructions
              .map((entry) => entry.message)
              .filter((batchedMessage) => {
                const key = parkedInputKey(batchedMessage);
                return key === undefined || !presentKeys.has(key);
              });
            if (newlyBatched.length > 0) {
              piMessages = [...(piMessages ?? []), ...newlyBatched];
            }
          }

          status.update();
          const assistantTitleTask = (async () => {
            if (conversationId) {
              const storedConversation = await getConversationStore().get({
                conversationId,
              });
              if (storedConversation?.title) {
                return undefined;
              }
            }
            return maybeUpdateAssistantTitle({
              assistantThreadContext,
              assistantUserName: botConfig.userName,
              channelId,
              conversation: preparedState.conversation,
              generateThreadTitle: deps.services.generateThreadTitle,
              getSlackAdapter: deps.getSlackAdapter,
              modelId: botConfig.fastModelId,
              actorId: slackActorId,
              runId,
              threadId,
            });
          })();
          void assistantTitleTask
            .then(async (titleUpdateResult) => {
              if (!titleUpdateResult) return;

              if (conversationId && titleUpdateResult.title) {
                try {
                  await getConversationStore().recordActivity({
                    activityAtMs: message.metadata.dateSent.getTime(),
                    conversationId,
                    nowMs: Date.now(),
                    title: titleUpdateResult.title,
                  });
                } catch (error) {
                  logException(error, "conversation.title.persist.failed");
                }
              }
            })
            .catch((error) => {
              logException(error, "assistant.title.task.failed");
            });
          const toolChannelId = channelId;
          const activeInstructionAuthorId =
            actor?.userId ?? parseActorUserId(message.author.userId);
          const activeInstructionAuthorName =
            actor?.fullName ?? actor?.userName;
          const promptConversationContext = appendRecentThreadMessagesToContext(
            preparedState.conversationContext,
            options.queuedMessages ?? [],
          );
          const drainSteeringMessages = options.drainSteeringMessages
            ? async (
                accept: (messages: AgentRunSteeringMessage[]) => Promise<void>,
              ): Promise<AgentRunSteeringMessage[]> => {
                let acceptedMessages: AgentRunSteeringMessage[] | undefined;
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
          const outcome = await deps.services.agentRunner.run({
            conversationId,
            turnId,
            ...(runId ? { runId } : {}),
            input: {
              actor: {
                ...(activeInstructionAuthorId
                  ? { authorId: activeInstructionAuthorId }
                  : {}),
                ...(activeInstructionAuthorName
                  ? { authorName: activeInstructionAuthorName }
                  : {}),
                ...(slackMessageTs ? { slackTs: slackMessageTs } : {}),
              },
              includeConversationContextWithPiMessages: hasDurablePromptHistory,
              messageText: effectiveUserText,
              conversationContext: promptConversationContext,
              piMessages,
              inboundAttachmentCount: turnAttachments.length,
              omittedImageAttachmentCount,
              userAttachments,
            },
            routing: {
              credentialContext,
              // Always set the execution actor when known. Resource-event turns
              // carry the system principal; interactive turns carry the Slack user.
              actor: executionActor,
              slackConversation,
              source,
              destination,
              publishExternally: shouldPublishExternally(options.publishExternally),
              ...(destinationVisibility ? { destinationVisibility } : {}),
              surface: options.execution?.surface ?? "slack",
              dispatch: options.execution?.dispatch,
              toolChannelId,
              slackActionToken,
            },
            policy: {
              configuration: preparedState.configuration,
              locationConfiguration: preparedState.locationConfiguration,
              disabledFeatures:
                options.execution?.disabledFeatures ??
                (message.author.isBot === true
                  ? (["interactive-auth"] as const)
                  : undefined),
              turnDeadlineAtMs: getTurnRequestDeadline()?.deadlineAtMs,
            },
            state: {
              pendingAuth: preparedState.conversation.processing.pendingAuth,
              sandboxRef: preparedState.sandboxRef,
            },
            observers: {
              onStatus: (nextStatus) => status.update(nextStatus),
              onToolInvocation: options.onToolInvocation,
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
          });
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
                    : {}),
                  failureCode: "agent_run_failed",
                  turnId,
                });
                lifecycleTerminalized = true;
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
            // A cooperative yield only occurs when this caller's own
            // shouldYield() fired, so the predicate — not the outcome —
            // decides the resume route: hand the lease back to the queue
            // worker, or schedule a direct continuation.
            if (options.shouldYield?.()) {
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
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                "app.ai.resume_session_version": outcome.resumeVersion,
              });
              shouldPersistFailureState = true;
              turnWakeError = scheduleError;
              throw scheduleError;
            }
            return;
          }

          let reply = outcome.result;
          setTags({ modelId: reply.diagnostics.modelId });
          const diagnosticsAttributes =
            getAgentTurnDiagnosticsAttributes(reply);
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome !== "success") {
            const finalized = finalizeFailedTurnReplyWithEvent({
              reply,
              logException,
            });
            reply = finalized.reply;
            finalizedFailureEventId = finalized.eventId;
            await deliverAssistantMessage(reply.text);
          }
          const turnResult: DispatchTurnResult =
            reply.diagnostics.outcome === "success"
              ? { outcome: "completed" }
              : {
                  errorMessage:
                    reply.diagnostics.errorMessage ??
                    `Agent turn ended with ${reply.diagnostics.outcome}.`,
                  outcome: "failed",
                };
          runResultHandled = true;
          shouldPersistFailureState = false;
          boundaryFailureCode = "agent_run_failed";

          const completedState = buildDeliveredTurnStatePatch({
            conversation: preparedState.conversation,
            reply,
            sessionId: turnId,
            userMessageId: preparedState.userMessageId,
          });
          try {
            // Commit the durable delivery record first so recovery cannot
            // regenerate an accepted reply. Persist canonical message
            // facts next, then update Redis runtime scratch independently.
            if (conversationId && reply.piMessages?.length) {
              await saveTurnCheckpoint({
                mode: "completed",
                channelName,
                conversationId,
                turnId,
                durationMs: reply.diagnostics.durationMs,
                usage: reply.diagnostics.usage,
                destination,
                destinationVisibility,
                source,
                sliceId: 1,
                dispatchOutcome:
                  reply.diagnostics.outcome === "success"
                    ? "completed"
                    : "failed",
                ...(options.execution?.dispatch && turnResult.errorMessage
                  ? { errorMessage: turnResult.errorMessage }
                  : {}),
                ...(acceptedDeliveryId
                  ? { resultMessageId: acceptedDeliveryId }
                  : {}),
                messages: reply.piMessages,
                actor: executionActor,
                surface: options.execution?.surface ?? "slack",
                dispatchId: options.execution?.dispatch?.id,
              });
            } else if (conversationId) {
              await recordTurnSummary({
                channelName,
                conversationId,
                cumulativeDurationMs: reply.diagnostics.durationMs,
                cumulativeUsage: reply.diagnostics.usage,
                turnId: turnId,
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
                  reply.diagnostics.outcome === "success"
                    ? "completed"
                    : "failed",
                ...(acceptedDeliveryId
                  ? { resultMessageId: acceptedDeliveryId }
                  : {}),
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
          } catch (commitError) {
            // The user already saw the reply; keep the turn successful and
            // record the persistence failure for operators.
            const persistenceEventId = logException(
              commitError,
              "slack.reply.post_delivery_commit.failed",
              messageTs ? { "messaging.message.id": messageTs } : {},
            );
            if (conversationId && !lifecycleTerminalized) {
              await deps.services.turnLifecycle.fail({
                conversationId,
                createdAtMs: Date.now(),
                ...(persistenceEventId ? { eventId: persistenceEventId } : {}),
                failureCode: "persistence_failed",
                turnId,
              });
              lifecycleTerminalized = true;
            }
          }
          preparedState.conversation = completedState.conversation;
          persistedAtLeastOnce = true;
          options.onTurnOutcome?.(turnResult);
          if (!lifecycleTerminalized && conversationId) {
            if (reply.diagnostics.outcome === "success") {
              await deps.services.turnLifecycle.complete({
                conversationId,
                createdAtMs: Date.now(),
                outcome: assistantMessageDelivered ? "success" : "no_reply",
                turnId,
              });
            } else {
              await deps.services.turnLifecycle.fail({
                conversationId,
                createdAtMs: Date.now(),
                ...(finalizedFailureEventId
                  ? { eventId: finalizedFailureEventId }
                  : {}),
                failureCode: "model_execution_failed",
                turnId,
              });
            }
            lifecycleTerminalized = true;
          }
          if (shouldEmitDevAgentTrace()) {
            logInfo("agent.turn.completed", {
              "app.ai.outcome": reply.diagnostics.outcome,
              "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
              "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
            });
          }
          await notifyTurnCompleted();
          if (reply.diagnostics.outcome === "success" && conversationId) {
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
          const classifiedFailure = getConversationTurnBoundaryError(error);
          const failureCause = classifiedFailure?.cause ?? error;
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
            ...(failureEventId ? { eventId: failureEventId } : {}),
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
                    : {}),
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
