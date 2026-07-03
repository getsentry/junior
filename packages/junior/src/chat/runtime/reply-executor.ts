/**
 * Slack reply execution boundary.
 *
 * This module bridges prepared Slack thread state into the agent runner
 * and commits the resulting Slack-visible delivery/state updates. It is where
 * queued messages, compaction, status updates, and Slack posting meet; agent
 * internals stay behind the runner seam.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import type { Message, SentMessage, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { getSlackMessageTs } from "@/chat/slack/message";
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
import {
  planSlackReplyPosts,
  postSlackApiReplyPosts,
  type PlannedSlackReplyStage,
} from "@/chat/slack/reply";
import { buildSlackOutputMessage } from "@/chat/slack/output";
import { getSlackErrorObservabilityAttributes } from "@/chat/slack/errors";
import {
  buildSteeringPiMessage,
  type ReplySteeringMessage,
} from "@/chat/respond";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { CredentialContext } from "@/chat/credentials/context";
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
import { persistThreadState } from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  combineTurnText,
  type PrepareTurnStateInput,
  type QueuedTurnMessage,
  type TurnMessageText,
  type TurnToolInvocation,
} from "@/chat/runtime/turn-input";
import {
  type ConversationMemoryService,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  generateConversationId,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import type { ContextCompactor } from "@/chat/services/context-compaction";
import { applyPendingAuthUpdate } from "@/chat/services/pending-auth";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/services/vision-context";
import {
  createSlackAdapterAssistantStatusSession,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { maybeUpdateAssistantTitle } from "@/chat/slack/assistant-thread/title";
import {
  conversationVisibilityFromSlackChannelType,
  resolveSlackChannelTypeFromMessage,
  resolveSlackConversationContext,
} from "@/chat/slack/conversation-context";
import { appendSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";
import { type ThreadArtifactsState } from "@/chat/state/artifacts";
import { lookupSlackUser } from "@/chat/slack/user";
import {
  toStoredSlackRequester,
  type SlackRequester,
  type StoredSlackRequester,
} from "@/chat/requester";
import { ensureSlackMessageActorIdentity } from "@/chat/services/message-actor-identity";
import type { AgentContinueRequest } from "@/chat/services/agent-continue";
import {
  CooperativeTurnYieldError,
  TurnInputDeferredError,
} from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { markTurnClosed, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import {
  finalizeFailedTurnReply,
  getAgentTurnDiagnosticsAttributes,
} from "@/chat/services/turn-failure-response";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { maybeApplyProviderDefaultConfigRequest } from "@/chat/services/provider-default-config";
import type { PiMessage } from "@/chat/pi/messages";
import {
  abandonAgentTurnSessionRecord,
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  recordAgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import {
  initConversationContext,
  setConversationTitle,
} from "@/chat/state/conversation-details";
import { commitMessages, loadProjection } from "@/chat/state/session-log";
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { persistWithRetry } from "@/chat/services/persist-retry";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/respond-helpers";
import { requireSlackDestination } from "@/chat/destination";

/**
 * Persist post-delivery thread state with a short retry so a transient state
 * write does not lose the delivered outcome of an already-accepted reply.
 */
async function persistThreadStateWithRetry(
  thread: Thread,
  patch: Parameters<typeof persistThreadState>[1],
): Promise<void> {
  await persistWithRetry(() => persistThreadState(thread, patch));
}

function collectCanvasUrls(artifacts: Partial<ThreadArtifactsState>) {
  return new Set(
    [
      artifacts.lastCanvasUrl,
      ...(artifacts.recentCanvases?.map((canvas) => canvas.url) ?? []),
    ].filter((url): url is string => typeof url === "string" && url !== ""),
  );
}

function turnRequester(requester: SlackRequester): StoredSlackRequester {
  return toStoredSlackRequester(requester);
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

function isResourceEventMessage(message: Message): boolean {
  const raw =
    message.raw && typeof message.raw === "object"
      ? (message.raw as Record<string, unknown>)
      : undefined;
  return raw?.event_type === "resource_event";
}

function resourceEventCredentialContext(
  message: Message,
): CredentialContext | undefined {
  return isResourceEventMessage(message)
    ? { actor: { type: "system", id: "resource-event" } }
    : undefined;
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

function getCurrentTurnCanvasUrl(args: {
  before: Partial<ThreadArtifactsState>;
  after: Partial<ThreadArtifactsState>;
}): string | undefined {
  const previousUrls = collectCanvasUrls(args.before);
  const latestUrls = collectCanvasUrls(args.after);
  for (const url of latestUrls) {
    if (!previousUrls.has(url)) {
      return url;
    }
  }
  return undefined;
}

function buildCanvasRecoveryReply(canvasUrl: string) {
  return `I created the canvas, but the turn was interrupted before I could finish the thread reply: ${canvasUrl}`;
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
  piMessages?: PiMessage[];
}

/**
 * Resolve the Pi history for this Slack turn from the most precise durable
 * boundary available: active turn record first, then compactable projection,
 * then caller fallback.
 */
async function loadPiMessagesForTurn(args: {
  conversationId?: string;
  activeTurnId?: string;
  fallback: PiMessage[];
}): Promise<LoadedPiMessagesForTurn> {
  const fallback = args.fallback.length > 0 ? [...args.fallback] : undefined;
  if (!args.conversationId) {
    return { piMessages: fallback };
  }

  if (args.activeTurnId) {
    const sessionRecord = await getAgentTurnSessionRecord(
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

  const projection = await loadProjection({
    conversationId: args.conversationId,
  });
  if (projection.length > 0) {
    return {
      canCompact: true,
      piMessages: projection,
    };
  }

  return { piMessages: fallback };
}

export interface ReplyExecutorServices {
  agentRunner: AgentRunner;
  contextCompactor: ContextCompactor;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
  getAwaitingAgentContinueRequest: (args: {
    conversationId: string;
    sessionId: string;
  }) => Promise<AgentContinueRequest | undefined>;
  lookupSlackUser: typeof lookupSlackUser;
  scheduleAgentContinue: (request: AgentContinueRequest) => Promise<void>;
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
      requesterId?: string;
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

/** Build the Slack reply handler that prepares state, runs Pi, and delivers replies. */
export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      destination: Destination;
      explicitMention?: boolean;
      ack?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: PreparedTurnState;
      queuedMessages?: QueuedTurnMessage[];
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
    const channelName = channelId
      ? await resolveChannelName(thread)
      : undefined;
    const slackChannelType = resolveSlackChannelTypeFromMessage(message);
    const slackConversation = resolveSlackConversationContext({
      channelId,
      channelName,
      channelType: slackChannelType,
    });
    // Source-confirmed visibility for destination persistence; undefined when
    // the event carries no channel_type so existing visibility is not changed.
    const destinationVisibility =
      conversationVisibilityFromSlackChannelType(slackChannelType);
    const threadTs = getThreadTs(threadId);
    const assistantThreadContext = getAssistantThreadContext(message);
    const messageTs = getMessageTs(message);
    const destination = requireSlackDestination(
      options.destination,
      "Slack reply execution",
    );
    const teamId = destination.teamId;
    const source = createSlackSource({
      channelId: channelId ?? destination.channelId,
      messageTs,
      teamId,
      threadTs,
      type: destinationVisibility === "public" ? "pub" : "priv",
    });
    const runId = getRunId(thread, message);
    const conversationId = threadId ?? runId;

    await withSpan(
      "chat.reply",
      "chat.reply",
      {
        conversationId,
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      async () => {
        const strippedUserText = stripLeadingBotMention(message.text, {
          botUserId: deps.getSlackAdapter().botUserId,
          stripLeadingSlackMentionToken:
            options.explicitMention || Boolean(message.isMention),
        });
        const currentText: TurnMessageText = {
          rawText: appendSlackLegacyAttachmentText(message.text, message.raw),
          userText: appendSlackLegacyAttachmentText(
            strippedUserText,
            message.raw,
          ),
        };
        const effectiveUserText = combineTurnText(
          options.queuedMessages ?? [],
          currentText,
        ).userText;
        await Promise.all(
          (options.queuedMessages ?? [])
            .filter((queued) => !isResourceEventMessage(queued.message))
            .map((queued) =>
              ensureSlackMessageActorIdentity(
                queued.message,
                teamId,
                deps.services.lookupSlackUser,
              ),
            ),
        );
        const credentialContext =
          resourceEventCredentialContext(message) ??
          ({
            actor: { type: "user", userId: message.author.userId },
          } satisfies CredentialContext);
        const requester =
          credentialContext.actor.type === "user"
            ? await ensureSlackMessageActorIdentity(
                message,
                teamId,
                deps.services.lookupSlackUser,
              )
            : undefined;
        const storedRequester = requester
          ? turnRequester(requester)
          : undefined;
        const slackRequesterId = requester?.userId;

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
            context: {
              threadId,
              requesterId: slackRequesterId,
              channelId,
              runId,
            },
          }));

        const slackMessageTs = getSlackMessageTs(message);
        const turnId = buildDeterministicTurnId(message.id);
        const turnTraceContext = {
          conversationId,
          slackThreadId: threadId,
          slackUserId: message.author.userId,
          slackChannelId: channelId,
          runId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId,
        };
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
        ): Promise<void> => {
          if (!requester) {
            throw new Error("Slack auth pause notice requires a requester");
          }
          const text = buildAuthPauseResponse(
            requester.userId,
            providerDisplayName,
          );
          const footer = buildSlackReplyFooter({ conversationId });
          try {
            if (channelId && threadTs) {
              await postSlackApiReplyPosts({
                beforePost: beforeFirstResponsePost,
                channelId,
                threadTs,
                posts: [
                  {
                    text,
                    stage: "thread_reply",
                  },
                ],
                footer,
              });
            } else {
              await beforeFirstResponsePost();
              await thread.post(buildSlackOutputMessage(text));
            }
          } catch (error) {
            logException(
              error,
              "slack_auth_pause_notice_post_failed",
              turnTraceContext,
              {
                "app.slack.reply_stage": "thread_reply_auth_pause_notice",
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                ...getSlackErrorObservabilityAttributes(error),
              },
              "Failed to post auth pause notice",
            );
          }
        };
        let activeTurnId = preparedState.conversation.processing.activeTurnId;
        const resolveSteeringMessages = async (
          queuedMessages: QueuedTurnMessage[],
        ): Promise<ReplySteeringMessage[]> => {
          return await Promise.all(
            queuedMessages.map(async (queued) => {
              const attachments = queued.message.attachments;
              return {
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
                    requesterId: isResourceEventMessage(queued.message)
                      ? undefined
                      : queued.message.author.userId,
                    channelId,
                    runId,
                    conversation: preparedState.conversation,
                    messageTs: getSlackMessageTs(queued.message),
                  },
                ),
              };
            }),
          );
        };
        /**
         * Durably append this turn's user input to the session log at the
         * parked safe boundary so the resumed `continue()` sees it. The
         * awaiting record pins the log session and materializes the projection
         * tail, so the append needs no record mutation. Must complete before
         * `ack` consumes the mailbox record.
         *
         * The read-compute-append races a concurrently-resumed slice, which
         * runs under the thread resume lock; take the same lock so the two
         * writers never interleave. Returns false when the lock is busy (a
         * live resume owns the session log): the caller must leave the
         * mailbox message pending for the next drain instead of consuming it.
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
          const stateAdapter = getStateAdapter();
          await stateAdapter.connect();
          const lock = await acquireActiveLock(stateAdapter, conversationId);
          if (!lock) {
            return false;
          }
          try {
            const piMessages = (
              await resolveSteeringMessages(parkedMessages)
            ).map(buildSteeringPiMessage);
            const projection = await loadProjection({ conversationId });
            // Dedupe per message: a partial-overlap redelivery (some messages
            // already appended before a schedule failure) must append only
            // the missing ones.
            const appendedKeys = new Set(
              projection
                .map(parkedInputKey)
                .filter((key): key is string => key !== undefined),
            );
            const missing = piMessages.filter((piMessage) => {
              const key = parkedInputKey(piMessage);
              return key === undefined || !appendedKeys.has(key);
            });
            if (missing.length === 0) {
              // A prior delivery already appended this input durably.
              return true;
            }
            await commitMessages({
              conversationId,
              messages: [...projection, ...missing],
              requester: storedRequester,
              ttlMs: THREAD_STATE_TTL_MS,
            });
            return true;
          } finally {
            await stateAdapter.releaseLock(lock);
          }
        };
        if (preparedState.userMessageAlreadyReplied) {
          await persistThreadState(thread, {
            conversation: preparedState.conversation,
          });
          await options.onTurnStatePersisted?.();
          await options.ack?.();
          await options.onTurnCompleted?.();
          return;
        }
        if (conversationId && activeTurnId) {
          const resumeRequest =
            await deps.services.getAwaitingAgentContinueRequest({
              conversationId,
              sessionId: activeTurnId,
            });
          if (resumeRequest) {
            // Durable session-log append first: rescheduling a continuation
            // does not consume the message, and `ack` may only
            // fire after the input is model-visible.
            if (!(await appendParkedTurnInput(resumeRequest.sessionId))) {
              // A live resume holds the thread lock; leave the mailbox
              // message pending so the next drain re-delivers it after the
              // resume completes.
              throw new TurnInputDeferredError();
            }
            try {
              await deps.services.scheduleAgentContinue(resumeRequest);
            } catch (error) {
              logException(
                error,
                "agent_continue_schedule_failed",
                turnTraceContext,
                {
                  "app.ai.resume_session_version":
                    resumeRequest.expectedVersion,
                  "app.ai.resume_session_id": resumeRequest.sessionId,
                  ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                },
                "Failed to reschedule active agent continuation",
              );
              throw error;
            }

            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            await options.onTurnStatePersisted?.();
            await options.ack?.();
            return;
          }

          const sessionRecord = await getAgentTurnSessionRecord(
            conversationId,
            activeTurnId,
          );
          if (sessionRecord?.state === "awaiting_resume") {
            if (sessionRecord.resumeReason === "auth") {
              // A user follow-up supersedes the auth-parked run: answer it
              // now as a fresh turn instead of consuming it into a pause that
              // may never resume. The parked prompt stays model-visible via
              // the session-log projection, pendingAuth state keeps the
              // authorization link reusable, and the abandoned record turns a
              // late OAuth callback into a stale no-op instead of a competing
              // run.
              await abandonAgentTurnSessionRecord({
                conversationId,
                sessionId: activeTurnId,
                errorMessage:
                  "Auth-parked session superseded by a new user message",
              });
              markTurnClosed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: activeTurnId,
                updateConversationStats,
              });
              activeTurnId = undefined;
            } else {
              await failAgentTurnSessionRecord({
                conversationId,
                expectedVersion: sessionRecord.version,
                sessionId: activeTurnId,
                errorMessage:
                  "Awaiting agent continuation metadata could not be materialized",
              });
              markTurnFailed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: activeTurnId,
                markConversationMessage,
                updateConversationStats,
              });
              activeTurnId = undefined;
            }
          }
        }
        const configReply = await maybeApplyProviderDefaultConfigRequest({
          channelConfiguration: preparedState.channelConfiguration,
          requesterId: requester?.userId,
          text: effectiveUserText,
        });
        if (configReply) {
          await beforeFirstResponsePost();
          await thread.post(buildSlackOutputMessage(configReply.text));
          markConversationMessage(
            preparedState.conversation,
            preparedState.userMessageId,
            {
              replied: true,
              skippedReason: undefined,
            },
          );
          upsertConversationMessage(preparedState.conversation, {
            id: generateConversationId("assistant"),
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
          updateConversationStats,
        });
        if (conversationId) {
          const turnStartedAtMs = message.metadata.dateSent.getTime();
          // Fire-and-forget: both calls are best-effort and must not delay
          // reply generation. Keep them independent so a failure in one does
          // not suppress observability of the other.
          void recordAgentTurnSessionSummary({
            channelName,
            conversationId,
            sessionId: turnId,
            sliceId: 1,
            startedAtMs: turnStartedAtMs,
            state: "running",
            surface: "slack",
            requester,
            destination,
            destinationVisibility,
            source,
            traceId: getActiveTraceId(),
          }).catch((error) => {
            logException(
              error,
              "agent_turn_summary_record_failed",
              turnTraceContext,
              { "app.agent.turn.state": "running" },
              "Failed to record running turn summary",
            );
          });
          void initConversationContext(conversationId, {
            channelName,
            originSurface: "slack",
            originRequester: storedRequester,
            startedAtMs: turnStartedAtMs,
          }).catch((error) => {
            logException(
              error,
              "conversation_details_context_init_failed",
              turnTraceContext,
              { "app.agent.turn.state": "running" },
              "Failed to init conversation context at turn start",
            );
          });
          const existingAssistantTitle =
            preparedState.artifacts.assistantTitle?.trim();
          if (existingAssistantTitle) {
            void setConversationTitle(conversationId, {
              displayTitle: existingAssistantTitle,
              ...(preparedState.artifacts.assistantTitleSourceMessageId
                ? {
                    titleSourceMessageId:
                      preparedState.artifacts.assistantTitleSourceMessageId,
                  }
                : {}),
            }).catch((error) => {
              logException(
                error,
                "conversation_details_title_refresh_failed",
                turnTraceContext,
                { "app.agent.turn.state": "running" },
                "Failed to refresh conversation title from artifacts",
              );
            });
          }
        }
        setTags({
          conversationId,
        });
        if (shouldEmitDevAgentTrace()) {
          logInfo(
            "agent_turn_started",
            turnTraceContext,
            {
              "app.message.id": message.id,
              ...(messageTs ? { "messaging.message.id": messageTs } : {}),
            },
            "Agent turn started",
          );
        }
        await persistThreadState(thread, {
          conversation: preparedState.conversation,
        });
        await options.onTurnStatePersisted?.();

        if (requester) {
          setSentryUser({
            id: requester.userId,
            ...(requester.userName ? { username: requester.userName } : {}),
            ...(requester.email ? { email: requester.email } : {}),
          });
        }
        if (requester?.userName) {
          setTags({ slackUserName: requester.userName });
        }
        const turnAttachments = collectTurnAttachments(
          message,
          options.queuedMessages,
        );
        const userAttachments = await deps.resolveUserAttachments(
          turnAttachments,
          {
            threadId,
            requesterId: slackRequesterId,
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
        const postThreadReply = async (
          payload: Parameters<typeof thread.post>[0],
          stage: PlannedSlackReplyStage,
        ): Promise<SentMessage> => {
          await beforeFirstResponsePost();
          try {
            return await thread.post(payload);
          } catch (error) {
            logException(
              error,
              "slack_thread_post_failed",
              turnTraceContext,
              {
                "app.slack.reply_stage": stage,
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                ...getSlackErrorObservabilityAttributes(error),
              },
              "Failed to post Slack thread reply",
            );
            throw error;
          }
        };
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;
        // Mirrors slack-resume's finalReplyDelivered guard: once the
        // destination accepted the final posts, later errors in the same turn
        // must not mark it failed or trigger the fallback failure reply.
        let finalReplyDelivered = false;
        let latestArtifacts = preparedState.artifacts;
        let assistantTitleArtifacts: Partial<ThreadArtifactsState> = {};
        let agentContinueScheduleError: unknown;
        const hasVisibleSlackDelivery = (post: {
          files?: unknown[];
          text: string;
        }) => post.text.trim().length > 0 || Boolean(post.files?.length);

        try {
          const loadedPiMessages = await loadPiMessagesForTurn({
            conversationId,
            activeTurnId,
            fallback: preparedState.conversation.piMessages,
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
                  requesterId: slackRequesterId,
                  channelId,
                  runId,
                },
                onCompactionStart: () => status.start(compactingStatus),
                piMessages,
              });
            if (compaction.compacted) {
              piMessages = compaction.piMessages;
              await persistThreadState(thread, {
                conversation: preparedState.conversation,
              });
            }
          }

          status.start();
          const assistantTitleTask = maybeUpdateAssistantTitle({
            assistantThreadContext,
            assistantUserName: botConfig.userName,
            artifacts: preparedState.artifacts,
            channelId,
            conversation: preparedState.conversation,
            generateThreadTitle: deps.services.generateThreadTitle,
            getSlackAdapter: deps.getSlackAdapter,
            modelId: botConfig.fastModelId,
            requesterId: slackRequesterId,
            runId,
            threadId,
          });
          void assistantTitleTask
            .then(async (titleUpdateResult) => {
              if (!titleUpdateResult) return;

              assistantTitleArtifacts = {
                assistantTitleSourceMessageId:
                  titleUpdateResult.sourceMessageId,
                ...(titleUpdateResult.title
                  ? { assistantTitle: titleUpdateResult.title }
                  : {}),
              };
              latestArtifacts = {
                ...latestArtifacts,
                ...assistantTitleArtifacts,
              };

              if (conversationId && titleUpdateResult.title) {
                try {
                  await setConversationTitle(conversationId, {
                    displayTitle: titleUpdateResult.title,
                    titleSourceMessageId: titleUpdateResult.sourceMessageId,
                  });
                } catch (error) {
                  logException(
                    error,
                    "conversation_details_title_set_failed",
                    turnTraceContext,
                    {},
                    "Failed to set conversation title in details record",
                  );
                }
              }

              try {
                await persistThreadState(thread, {
                  artifacts: latestArtifacts,
                });
              } catch (error) {
                logException(
                  error,
                  "assistant_title_artifact_persist_failed",
                  turnTraceContext,
                  {},
                  "Failed to persist async assistant title artifact state",
                );
              }
            })
            .catch((error) => {
              logException(
                error,
                "assistant_title_task_failed",
                turnTraceContext,
                {},
                "Async assistant title task failed",
              );
            });
          const toolChannelId =
            preparedState.artifacts.assistantContextChannelId ?? channelId;
          const drainSteeringMessages = options.drainSteeringMessages
            ? async (
                accept: (messages: ReplySteeringMessage[]) => Promise<void>,
              ): Promise<ReplySteeringMessage[]> => {
                let acceptedMessages: ReplySteeringMessage[] | undefined;
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
          const outcome = await deps.services.agentRunner.run(
            effectiveUserText,
            {
              credentialContext,
              requester,
              conversationContext: preparedState.conversationContext,
              artifactState: preparedState.artifacts,
              piMessages,
              pendingAuth: preparedState.conversation.processing.pendingAuth,
              configuration: preparedState.configuration,
              channelConfiguration: preparedState.channelConfiguration,
              inboundAttachmentCount: turnAttachments.length,
              omittedImageAttachmentCount,
              userAttachments,
              slackConversation,
              source,
              destination,
              surface: "slack",
              authorizationFlowMode:
                message.author.isBot === true ? "disabled" : undefined,
              turnDeadlineAtMs: getTurnRequestDeadline()?.deadlineAtMs,
              correlation: {
                conversationId,
                threadId,
                turnId,
                threadTs,
                messageTs,
                teamId,
                runId,
                channelId,
                channelName,
                requesterId: slackRequesterId,
              },
              toolChannelId,
              sandbox: {
                sandboxId: preparedState.sandboxId,
                sandboxDependencyProfileHash:
                  preparedState.sandboxDependencyProfileHash,
              },
              onSandboxAcquired: async (sandbox) => {
                await persistThreadState(thread, {
                  sandboxId: sandbox.sandboxId,
                  sandboxDependencyProfileHash:
                    sandbox.sandboxDependencyProfileHash,
                });
              },
              onArtifactStateUpdated: async (artifacts) => {
                latestArtifacts = {
                  ...artifacts,
                  ...assistantTitleArtifacts,
                };
                await persistThreadState(thread, {
                  artifacts: latestArtifacts,
                });
              },
              recordPendingAuth: async (pendingAuth) => {
                await applyPendingAuthUpdate({
                  conversation: preparedState.conversation,
                  conversationId,
                  nextPendingAuth: pendingAuth,
                });
                await persistThreadState(thread, {
                  conversation: preparedState.conversation,
                });
              },
              onStatus: (nextStatus) => status.update(nextStatus),
              onToolInvocation: options.onToolInvocation,
              onInputCommitted: options.ack,
              drainSteeringMessages,
              shouldYield: options.shouldYield,
            },
          );
          if (outcome.status === "awaiting_auth") {
            if (!requester) {
              const text = `I could not act on this subscribed event because ${outcome.providerDisplayName} needs user authorization. Ask me in this thread to connect ${outcome.providerDisplayName} before retrying.`;
              await postThreadReply(
                buildSlackOutputMessage(text),
                "thread_reply",
              );
              markConversationMessage(
                preparedState.conversation,
                preparedState.userMessageId,
                {
                  replied: true,
                  skippedReason: undefined,
                },
              );
              upsertConversationMessage(preparedState.conversation, {
                id: generateConversationId("assistant"),
                role: "assistant",
                text: normalizeConversationText(text),
                createdAtMs: Date.now(),
                author: {
                  userName: botConfig.userName,
                  isBot: true,
                },
                meta: {
                  replied: true,
                },
              });
              markTurnClosed({
                conversation: preparedState.conversation,
                nowMs: Date.now(),
                sessionId: turnId,
                updateConversationStats,
              });
              await persistThreadState(thread, {
                conversation: preparedState.conversation,
              });
              persistedAtLeastOnce = true;
              shouldPersistFailureState = false;
              return;
            }
            await postAuthPauseNotice(outcome.providerDisplayName);
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
                "Agent continuation requires a destination and conversation id",
              );
            }
            try {
              await deps.services.scheduleAgentContinue({
                conversationId,
                destination,
                sessionId: turnId,
                expectedVersion: outcome.resumeVersion,
              });
              shouldPersistFailureState = false;
            } catch (scheduleError) {
              logException(
                scheduleError,
                "agent_continue_schedule_failed",
                turnTraceContext,
                {
                  ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                  "app.ai.resume_session_version": outcome.resumeVersion,
                },
                "Failed to schedule agent continuation",
              );
              shouldPersistFailureState = true;
              agentContinueScheduleError = scheduleError;
              throw scheduleError;
            }
            return;
          }

          let reply = outcome.reply;
          const diagnosticsContext = {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            runId,
            assistantUserName: botConfig.userName,
            modelId: reply.diagnostics.modelId,
          };
          const diagnosticsAttributes =
            getAgentTurnDiagnosticsAttributes(reply);
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome !== "success") {
            reply = finalizeFailedTurnReply({
              reply,
              logException,
              context: diagnosticsContext,
            });
          }

          const artifactStatePatch: Partial<ThreadArtifactsState> =
            reply.artifactStatePatch ? { ...reply.artifactStatePatch } : {};

          const plannedPosts = planSlackReplyPosts({ reply });
          const replyFooter = buildSlackReplyFooter({
            conversationId,
          });
          const shouldUseSlackFooter =
            Boolean(replyFooter) &&
            Boolean(channelId && threadTs) &&
            (thread.adapter as { name?: string } | undefined)?.name === "slack";

          // Text replies must be accepted by Slack before completion;
          // side-effect-only turns may already be visibly complete.
          if (plannedPosts.length > 0) {
            const hasVisibleDelivery = plannedPosts.some(
              hasVisibleSlackDelivery,
            );
            if (!hasVisibleDelivery) {
              throw new Error(
                "Slack final reply plan did not contain visible delivery",
              );
            }
            if (shouldUseSlackFooter) {
              const slackChannelId = channelId;
              const slackThreadTs = threadTs;
              if (!slackChannelId || !slackThreadTs) {
                throw new Error(
                  "Slack footer delivery requires a concrete channel and thread timestamp",
                );
              }

              await postSlackApiReplyPosts({
                beforePost: beforeFirstResponsePost,
                channelId: slackChannelId,
                threadTs: slackThreadTs,
                posts: plannedPosts,
                fileUploadFailureMode: "strict",
                footer: replyFooter,
                onPostError: ({ error, messageTs, stage }) => {
                  logException(
                    error,
                    "slack_thread_post_failed",
                    turnTraceContext,
                    {
                      "app.slack.reply_stage": stage,
                      ...(messageTs
                        ? { "messaging.message.id": messageTs }
                        : {}),
                      ...getSlackErrorObservabilityAttributes(error),
                    },
                    "Failed to post Slack thread reply",
                  );
                },
              });
            } else {
              for (const post of plannedPosts) {
                if (!hasVisibleSlackDelivery(post)) {
                  continue;
                }
                await postThreadReply(
                  buildSlackOutputMessage(post.text, post.files),
                  post.stage,
                );
              }
            }
            // Slack accepted every final post: the turn is delivered even if
            // completion persistence below fails.
            finalReplyDelivered = true;
            shouldPersistFailureState = false;
          } else {
            // Side-effect-only turns (for example reactions or channel posts)
            // have no thread reply to deliver; the successful tool result is
            // the visible Slack acceptance boundary.
            finalReplyDelivered = true;
            shouldPersistFailureState = false;
          }

          const completedState = buildDeliveredTurnStatePatch({
            artifactStatePatch: {
              ...artifactStatePatch,
              ...assistantTitleArtifacts,
            },
            artifacts: latestArtifacts,
            conversation: preparedState.conversation,
            reply,
            sessionId: turnId,
            userMessageId: preparedState.userMessageId,
          });
          if (completedState.artifacts) {
            latestArtifacts = completedState.artifacts;
          }
          try {
            // Commit the terminal completed session record first: it is the
            // delivered marker that keeps stranded-running recovery from
            // regenerating an already-delivered reply if the thread-state
            // write below fails.
            if (conversationId && reply.piMessages?.length) {
              await completeDeliveredTurn({
                channelName,
                conversationId,
                durationMs: reply.diagnostics.durationMs,
                usage: reply.diagnostics.usage,
                destination,
                destinationVisibility,
                source,
                sessionId: turnId,
                sliceId: 1,
                messages: reply.piMessages,
                logContext: {
                  threadId,
                  requesterId: slackRequesterId,
                  channelId,
                  runId,
                  assistantUserName: botConfig.userName,
                  modelId: reply.diagnostics.modelId,
                },
                requester,
                surface: "slack",
              });
            } else if (conversationId) {
              await recordAgentTurnSessionSummary({
                channelName,
                conversationId,
                cumulativeDurationMs: reply.diagnostics.durationMs,
                cumulativeUsage: reply.diagnostics.usage,
                sessionId: turnId,
                sliceId: 1,
                startedAtMs: message.metadata.dateSent.getTime(),
                state: "completed",
                requester,
                destination,
                destinationVisibility,
                source,
                traceId: getActiveTraceId(),
              });
            }
            await persistThreadStateWithRetry(thread, {
              ...completedState,
            });
            if (
              completedState.artifacts &&
              (assistantTitleArtifacts.assistantTitle !== undefined ||
                assistantTitleArtifacts.assistantTitleSourceMessageId !==
                  undefined) &&
              (completedState.artifacts.assistantTitle !==
                assistantTitleArtifacts.assistantTitle ||
                completedState.artifacts.assistantTitleSourceMessageId !==
                  assistantTitleArtifacts.assistantTitleSourceMessageId)
            ) {
              await persistThreadStateWithRetry(thread, {
                artifacts: latestArtifacts,
              });
            }
          } catch (commitError) {
            // The user already saw the reply; keep the turn successful and
            // record the persistence failure for operators.
            logException(
              commitError,
              "slack_reply_post_delivery_commit_failed",
              turnTraceContext,
              messageTs ? { "messaging.message.id": messageTs } : {},
              "Post-delivery turn state persistence failed after Slack accepted the reply",
            );
          }
          preparedState.conversation = completedState.conversation;
          persistedAtLeastOnce = true;
          if (shouldEmitDevAgentTrace()) {
            logInfo(
              "agent_turn_completed",
              turnTraceContext,
              {
                "app.ai.outcome": reply.diagnostics.outcome,
                "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
                "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
              },
              "Agent turn completed",
            );
          }
          await options.onTurnCompleted?.();
          if (reply.diagnostics.outcome === "success" && conversationId) {
            try {
              await deps.services.scheduleSessionCompletedPluginTasks({
                conversationId,
                sessionId: turnId,
              });
            } catch (error) {
              logException(
                error,
                "plugin_session_completed_task_schedule_failed",
                turnTraceContext,
                {},
                "Plugin session.completed task scheduling failed",
              );
            }
          }
        } catch (error) {
          if (finalReplyDelivered) {
            // Delivered-turn guard: errors after Slack accepted the final
            // reply (redundant-ack cleanup, completion callbacks) must not
            // fail the turn or trigger the visible failure fallback.
            shouldPersistFailureState = false;
            logException(
              error,
              "slack_reply_post_delivery_commit_failed",
              turnTraceContext,
              messageTs ? { "messaging.message.id": messageTs } : {},
              "Post-delivery turn work failed after Slack accepted the reply",
            );
            return;
          }
          if (error instanceof CooperativeTurnYieldError) {
            shouldPersistFailureState = false;
            throw error;
          }
          if (error === agentContinueScheduleError) {
            shouldPersistFailureState = true;
            throw error;
          }
          shouldPersistFailureState = true;
          const createdCanvasUrl = getCurrentTurnCanvasUrl({
            before: preparedState.artifacts,
            after: latestArtifacts,
          });
          if (createdCanvasUrl) {
            logException(
              error,
              "agent_turn_failed_after_canvas_created",
              turnTraceContext,
              {
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                "app.slack.canvas.has_url": true,
              },
              "Agent turn failed after creating a Slack canvas",
            );
            const recoveryText = buildCanvasRecoveryReply(createdCanvasUrl);
            await postThreadReply(
              buildSlackOutputMessage(recoveryText),
              "thread_reply",
            );
            markConversationMessage(
              preparedState.conversation,
              preparedState.userMessageId,
              {
                replied: true,
                skippedReason: undefined,
              },
            );
            upsertConversationMessage(preparedState.conversation, {
              id: generateConversationId("assistant"),
              role: "assistant",
              text: normalizeConversationText(recoveryText),
              createdAtMs: Date.now(),
              author: {
                userName: botConfig.userName,
                isBot: true,
              },
              meta: {
                replied: true,
              },
            });
            markTurnClosed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              sessionId: turnId,
              updateConversationStats,
            });
            await persistThreadState(thread, {
              artifacts: latestArtifacts,
              conversation: preparedState.conversation,
            });
            persistedAtLeastOnce = true;
            shouldPersistFailureState = false;
            return;
          }
          throw error;
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
              updateConversationStats,
            });
            if (conversationId) {
              try {
                await recordAgentTurnSessionSummary({
                  channelName,
                  conversationId,
                  sessionId: turnId,
                  sliceId: 1,
                  startedAtMs: message.metadata.dateSent.getTime(),
                  state: "failed",
                  requester,
                  destination,
                  destinationVisibility,
                  source,
                  traceId: getActiveTraceId(),
                });
                const sessionRecord = await getAgentTurnSessionRecord(
                  conversationId,
                  turnId,
                );
                if (sessionRecord) {
                  await failAgentTurnSessionRecord({
                    conversationId,
                    expectedVersion: sessionRecord.version,
                    sessionId: turnId,
                    errorMessage:
                      "Agent turn failed before final reply delivery completed",
                  });
                }
              } catch (recordError) {
                logException(
                  recordError,
                  "agent_turn_failed_session_record_persist_failed",
                  turnTraceContext,
                  {},
                  "Failed to mark failed turn session record",
                );
              }
            }
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            if (shouldEmitDevAgentTrace()) {
              logWarn(
                "agent_turn_failed",
                turnTraceContext,
                {},
                "Agent turn failed",
              );
            }
          }
          await status.stop();
        }
      },
    );
  };
}
