/**
 * Slack reply execution boundary.
 *
 * This module bridges prepared Slack thread state into `generateAssistantReply`
 * and commits the resulting Slack-visible delivery/state updates. It is where
 * queued messages, compaction, status updates, and Slack posting meet; agent
 * internals stay behind the reply generator.
 */
import type { Message, SentMessage, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
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
  generateAssistantReply as generateAssistantReplyImpl,
  type ReplySteeringMessage,
} from "@/chat/respond";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  getAssistantThreadContext,
  getChannelId,
  getMessageTs,
  getTeamId,
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
  resolveSlackChannelTypeFromMessage,
  resolveSlackConversationContext,
} from "@/chat/slack/conversation-context";
import { appendSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";
import { type ThreadArtifactsState } from "@/chat/state/artifacts";
import { lookupSlackUser } from "@/chat/slack/user";
import type { TurnContinuationRequest } from "@/chat/services/timeout-resume";
import {
  isCooperativeTurnYieldError,
  isRetryableTurnError,
} from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { markTurnClosed, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import { isRedundantReactionAckText } from "@/chat/services/reply-delivery-plan";
import { deleteSlackMessage } from "@/chat/slack/outbound";
import {
  finalizeFailedTurnReply,
  getAgentTurnDiagnosticsAttributes,
} from "@/chat/services/turn-failure-response";
import { buildAuthPauseResponse } from "@/chat/services/auth-pause-response";
import { maybeApplyProviderDefaultConfigRequest } from "@/chat/services/provider-default-config";
import type { PiMessage } from "@/chat/pi/messages";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  recordAgentTurnSessionSummary,
  type AgentTurnRequester,
} from "@/chat/state/turn-session";
import { loadProjection } from "@/chat/state/session-log";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/respond-helpers";

function collectCanvasUrls(artifacts: Partial<ThreadArtifactsState>) {
  return new Set(
    [
      artifacts.lastCanvasUrl,
      ...(artifacts.recentCanvases?.map((canvas) => canvas.url) ?? []),
    ].filter((url): url is string => typeof url === "string" && url !== ""),
  );
}

function turnRequester(args: {
  email?: string;
  fullName?: string;
  userId?: string;
  userName?: string;
}): AgentTurnRequester | undefined {
  const requester: AgentTurnRequester = {
    ...(args.email ? { email: args.email } : {}),
    ...(args.fullName ? { fullName: args.fullName } : {}),
    ...(args.userId ? { slackUserId: args.userId } : {}),
    ...(args.userName ? { slackUserName: args.userName } : {}),
  };
  return Object.keys(requester).length > 0 ? requester : undefined;
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
  contextCompactor: ContextCompactor;
  generateAssistantReply: typeof generateAssistantReplyImpl;
  generateThreadTitle: ConversationMemoryService["generateThreadTitle"];
  getAwaitingTurnContinuationRequest: (args: {
    conversationId: string;
    sessionId: string;
  }) => Promise<TurnContinuationRequest | undefined>;
  lookupSlackUser: typeof lookupSlackUser;
  scheduleTurnTimeoutResume: (
    request: TurnContinuationRequest,
  ) => Promise<void>;
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
      explicitMention?: boolean;
      onInputCommitted?: () => Promise<void>;
      onToolInvocation?: (invocation: TurnToolInvocation) => void;
      onTurnCompleted?: () => Promise<void>;
      onTurnStatePersisted?: () => Promise<void>;
      preparedState?: PreparedTurnState;
      queuedMessages?: QueuedTurnMessage[];
      drainSteeringMessages?: (
        inject: (messages: QueuedTurnMessage[]) => Promise<void>,
      ) => Promise<QueuedTurnMessage[]>;
      shouldYield?: () => boolean;
    } = {},
  ) {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const channelName = channelId
      ? await resolveChannelName(thread)
      : undefined;
    const slackConversation = resolveSlackConversationContext({
      channelId,
      channelName,
      channelType: resolveSlackChannelTypeFromMessage(message),
    });
    const threadTs = getThreadTs(threadId);
    const assistantThreadContext = getAssistantThreadContext(message);
    const messageTs = getMessageTs(message);
    const teamId = getTeamId(message);
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
              requesterId: message.author.userId,
              channelId,
              runId,
            },
          }));

        const slackMessageTs = getSlackMessageTs(message);
        const turnId = buildDeterministicTurnId(message.id);
        const fallbackIdentity = await deps.services.lookupSlackUser(
          message.author.userId,
        );
        const requester = turnRequester({
          email: fallbackIdentity?.email,
          fullName: message.author.fullName ?? fallbackIdentity?.fullName,
          userId: message.author.userId,
          userName: message.author.userName ?? fallbackIdentity?.userName,
        });
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
        const postAuthPauseNotice = async (): Promise<void> => {
          try {
            await beforeFirstResponsePost();
            await thread.post(
              buildSlackOutputMessage(buildAuthPauseResponse()),
            );
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
        if (preparedState.userMessageAlreadyReplied) {
          await persistThreadState(thread, {
            conversation: preparedState.conversation,
          });
          await options.onTurnStatePersisted?.();
          await options.onInputCommitted?.();
          await options.onTurnCompleted?.();
          return;
        }
        if (conversationId && activeTurnId) {
          const resumeRequest =
            await deps.services.getAwaitingTurnContinuationRequest({
              conversationId,
              sessionId: activeTurnId,
            });
          if (resumeRequest) {
            try {
              await deps.services.scheduleTurnTimeoutResume(resumeRequest);
            } catch (error) {
              logException(
                error,
                "agent_turn_continuation_retry_schedule_failed",
                turnTraceContext,
                {
                  "app.ai.resume_session_version":
                    resumeRequest.expectedVersion,
                  "app.ai.resume_session_id": resumeRequest.sessionId,
                  ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                },
                "Failed to reschedule active turn continuation",
              );
              throw error;
            }

            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            await options.onTurnStatePersisted?.();
            await options.onInputCommitted?.();
            return;
          }

          const sessionRecord = await getAgentTurnSessionRecord(
            conversationId,
            activeTurnId,
          );
          if (sessionRecord?.state === "awaiting_resume") {
            if (sessionRecord.resumeReason === "auth") {
              await persistThreadState(thread, {
                conversation: preparedState.conversation,
              });
              await options.onTurnStatePersisted?.();
              await options.onInputCommitted?.();
              return;
            }

            await failAgentTurnSessionRecord({
              conversationId,
              expectedVersion: sessionRecord.version,
              sessionId: activeTurnId,
              errorMessage:
                "Awaiting turn continuation metadata could not be materialized",
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
        const configReply = await maybeApplyProviderDefaultConfigRequest({
          channelConfiguration: preparedState.channelConfiguration,
          requesterId: message.author.userId,
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
          await options.onInputCommitted?.();
          return;
        }
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats,
        });
        if (conversationId) {
          // Fire-and-forget: recording the "running" state is best-effort and
          // must not delay reply generation.
          void recordAgentTurnSessionSummary({
            channelName,
            conversationId,
            sessionId: turnId,
            sliceId: 1,
            startedAtMs: message.metadata.dateSent.getTime(),
            state: "running",
            surface: "slack",
            requester,
            traceId: getActiveTraceId(),
          }).catch((error) => {
            logException(
              error,
              "agent_turn_summary_record_failed",
              turnTraceContext,
              {
                "app.agent.turn.state": "running",
              },
              "Failed to record running turn summary",
            );
          });
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

        const resolvedUserName =
          message.author.userName ?? fallbackIdentity?.userName;
        if (message.author.userId) {
          setSentryUser({
            id: message.author.userId,
            ...(resolvedUserName ? { username: resolvedUserName } : {}),
            ...(fallbackIdentity?.email
              ? { email: fallbackIdentity.email }
              : {}),
          });
        }
        if (resolvedUserName) {
          setTags({ slackUserName: resolvedUserName });
        }
        const turnAttachments = collectTurnAttachments(
          message,
          options.queuedMessages,
        );
        const userAttachments = await deps.resolveUserAttachments(
          turnAttachments,
          {
            threadId,
            requesterId: message.author.userId,
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
        let latestArtifacts = preparedState.artifacts;

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
                  requesterId: message.author.userId,
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
            requesterId: message.author.userId,
            runId,
            threadId,
          });
          const toolChannelId =
            preparedState.artifacts.assistantContextChannelId ?? channelId;
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
                    !isVisionEnabled() &&
                    hasPotentialImageAttachment(attachments)
                      ? countPotentialImageAttachments(attachments)
                      : 0,
                  userAttachments: await deps.resolveUserAttachments(
                    attachments,
                    {
                      threadId,
                      requesterId: queued.message.author.userId,
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
          const drainSteeringMessages = options.drainSteeringMessages
            ? async (
                inject: (messages: ReplySteeringMessage[]) => Promise<void>,
              ): Promise<ReplySteeringMessage[]> => {
                let injectedMessages: ReplySteeringMessage[] | undefined;
                const drained = await options.drainSteeringMessages!(
                  async (queuedMessages) => {
                    injectedMessages =
                      await resolveSteeringMessages(queuedMessages);
                    await inject(injectedMessages);
                  },
                );
                return (
                  injectedMessages ?? (await resolveSteeringMessages(drained))
                );
              }
            : undefined;
          let reply = await deps.services.generateAssistantReply(
            effectiveUserText,
            {
              credentialContext: {
                actor: { type: "user", userId: message.author.userId },
              },
              requester: {
                userId: message.author.userId,
                userName: message.author.userName ?? fallbackIdentity?.userName,
                fullName: message.author.fullName ?? fallbackIdentity?.fullName,
                email: fallbackIdentity?.email,
              },
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
              surface: "slack",
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
                requesterId: message.author.userId,
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
                latestArtifacts = artifacts;
                await persistThreadState(thread, { artifacts });
              },
              onAuthPending: async (pendingAuth) => {
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
              onInputCommitted: options.onInputCommitted,
              drainSteeringMessages,
              shouldYield: options.shouldYield,
            },
          );
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

          const reactionPerformed = reply.diagnostics.toolCalls.includes(
            "slackMessageAddReaction",
          );
          const plannedPosts = planSlackReplyPosts({ reply });
          const replyFooter = buildSlackReplyFooter({
            conversationId,
            durationMs: reply.diagnostics.durationMs,
            thinkingLevel: reply.diagnostics.thinkingLevel,
            usage: reply.diagnostics.usage,
          });
          const shouldUseSlackFooter =
            Boolean(replyFooter) &&
            Boolean(channelId && threadTs) &&
            (thread.adapter as { name?: string } | undefined)?.name === "slack";

          // Final Slack delivery is part of turn success. We only mark the turn
          // completed after the visible reply has been accepted by Slack.
          if (plannedPosts.length > 0) {
            let sent: SentMessage | undefined;
            if (shouldUseSlackFooter) {
              const slackChannelId = channelId;
              const slackThreadTs = threadTs;
              if (!slackChannelId || !slackThreadTs) {
                throw new Error(
                  "Slack footer delivery requires a concrete channel and thread timestamp",
                );
              }

              const sentMessageTs = await postSlackApiReplyPosts({
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

              if (sentMessageTs) {
                sent = {
                  id: sentMessageTs,
                  text: reply.text,
                  delete: async () => {
                    await deleteSlackMessage({
                      channelId: slackChannelId,
                      timestamp: sentMessageTs,
                    });
                  },
                } as SentMessage;
              }
            } else {
              for (const post of plannedPosts) {
                sent = await postThreadReply(
                  buildSlackOutputMessage(post.text, post.files),
                  post.stage,
                );
              }
            }
            const firstPlannedMessageHasFiles =
              (plannedPosts[0]?.files?.length ?? 0) > 0;
            // When a reaction already acknowledged the turn, delete the
            // redundant thread reply. The post itself completes Slack's
            // assistant response cycle (clearing the typing indicator).
            if (
              sent &&
              reactionPerformed &&
              plannedPosts.length === 1 &&
              !firstPlannedMessageHasFiles &&
              isRedundantReactionAckText(reply.text)
            ) {
              await sent.delete();
            }
          }

          const titleUpdateResult = await assistantTitleTask;
          if (titleUpdateResult) {
            artifactStatePatch.assistantTitleSourceMessageId =
              titleUpdateResult.sourceMessageId;
            if (titleUpdateResult.title) {
              artifactStatePatch.assistantTitle = titleUpdateResult.title;
            }
          }

          const completedState = buildDeliveredTurnStatePatch({
            artifactStatePatch,
            artifacts: preparedState.artifacts,
            conversation: preparedState.conversation,
            reply,
            sessionId: turnId,
            userMessageId: preparedState.userMessageId,
          });
          await persistThreadState(thread, {
            ...completedState,
          });
          if (conversationId) {
            await recordAgentTurnSessionSummary({
              channelName,
              conversationId,
              cumulativeDurationMs: reply.diagnostics.durationMs,
              cumulativeUsage: reply.diagnostics.usage,
              sessionId: turnId,
              sliceId: 1,
              startedAtMs: message.metadata.dateSent.getTime(),
              state: "completed",
              conversationTitle: titleUpdateResult?.title,
              requester,
              traceId: getActiveTraceId(),
            });
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
        } catch (error) {
          if (isCooperativeTurnYieldError(error)) {
            shouldPersistFailureState = false;
            throw error;
          }

          if (
            isRetryableTurnError(error, "mcp_auth_resume") ||
            isRetryableTurnError(error, "plugin_auth_resume")
          ) {
            await postAuthPauseNotice();
            completeAuthPauseTurn({
              conversation: preparedState.conversation,
              sessionId: error.metadata?.sessionId ?? turnId,
            });
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            persistedAtLeastOnce = true;
            shouldPersistFailureState = false;
            return;
          }

          if (isRetryableTurnError(error, "turn_timeout_resume")) {
            const conversationIdForResume = error.metadata?.conversationId;
            const sessionIdForResume = error.metadata?.sessionId;
            const version = error.metadata?.version;
            if (
              conversationIdForResume &&
              sessionIdForResume &&
              typeof version === "number"
            ) {
              try {
                await deps.services.scheduleTurnTimeoutResume({
                  conversationId: conversationIdForResume,
                  sessionId: sessionIdForResume,
                  expectedVersion: version,
                });
                shouldPersistFailureState = false;
              } catch (scheduleError) {
                logException(
                  scheduleError,
                  "agent_turn_timeout_resume_schedule_failed",
                  turnTraceContext,
                  {
                    ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                    "app.ai.resume_session_version": version,
                  },
                  "Failed to schedule timeout resume callback",
                );
                shouldPersistFailureState = true;
                throw scheduleError;
              }
              return;
            } else {
              logWarn(
                "agent_turn_timeout_resume_metadata_missing",
                turnTraceContext,
                messageTs ? { "messaging.message.id": messageTs } : {},
                "Timed-out turn could not be scheduled for resume because retry metadata was incomplete",
              );
            }
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
