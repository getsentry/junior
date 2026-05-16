import type { Message, SentMessage, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { getSlackMessageTs } from "@/chat/slack/message";
import {
  logException,
  logInfo,
  logWarn,
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
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
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
import {
  persistThreadState,
  mergeArtifactsState,
} from "@/chat/runtime/thread-state";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  type ConversationMemoryService,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  generateConversationId,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { applyPendingAuthUpdate } from "@/chat/services/pending-auth";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/services/vision-context";
import { createSlackAdapterAssistantStatusSession } from "@/chat/slack/assistant-thread/status";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { maybeUpdateAssistantTitle } from "@/chat/slack/assistant-thread/title";
import { appendSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";
import { type ThreadArtifactsState } from "@/chat/state/artifacts";
import { lookupSlackUser } from "@/chat/slack/user";
import type { TurnContinuationRequest } from "@/chat/services/timeout-resume";
import { canScheduleTurnTimeoutResume } from "@/chat/services/timeout-resume";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import { isRedundantReactionAckText } from "@/chat/services/reply-delivery-plan";
import { deleteSlackMessage } from "@/chat/slack/outbound";
import {
  finalizeFailedTurnReply,
  getAgentTurnDiagnosticsAttributes,
} from "@/chat/services/turn-failure-response";
import { buildTurnContinuationResponse } from "@/chat/services/turn-continuation-response";

export interface ReplyExecutorServices {
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
  prepareTurnState: (args: {
    explicitMention: boolean;
    message: Message;
    thread: Thread;
    userText: string;
    context: {
      threadId?: string;
      requesterId?: string;
      channelId?: string;
      runId?: string;
    };
  }) => Promise<PreparedTurnState>;
  services: ReplyExecutorServices;
}

export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
      onToolInvocation?: (invocation: {
        params: Record<string, unknown>;
        toolName: string;
      }) => void;
      preparedState?: PreparedTurnState;
    } = {},
  ) {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const threadTs = getThreadTs(threadId);
    const assistantThreadContext = getAssistantThreadContext(message);
    const messageTs = getMessageTs(message);
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
          stripLeadingSlackMentionToken:
            options.explicitMention || Boolean(message.isMention),
        });
        const userText = appendSlackLegacyAttachmentText(
          strippedUserText,
          message.raw,
        );

        const preparedState =
          options.preparedState ??
          (await deps.prepareTurnState({
            thread,
            message,
            userText,
            explicitMention: Boolean(
              options.explicitMention || message.isMention,
            ),
            context: {
              threadId,
              requesterId: message.author.userId,
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
        const postTurnContinuationNotice = async (): Promise<void> => {
          try {
            await beforeFirstResponsePost();
            await thread.post(
              buildSlackOutputMessage(buildTurnContinuationResponse()),
            );
          } catch (error) {
            logException(
              error,
              "slack_turn_continuation_notice_post_failed",
              turnTraceContext,
              {
                "app.slack.reply_stage":
                  "thread_reply_turn_continuation_notice",
                ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                ...getSlackErrorObservabilityAttributes(error),
              },
              "Failed to post turn continuation notice",
            );
            throw error;
          }
        };
        const activeTurnId = preparedState.conversation.processing.activeTurnId;
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
                  "app.ai.resume_checkpoint_version":
                    resumeRequest.expectedCheckpointVersion,
                  "app.ai.resume_session_id": resumeRequest.sessionId,
                  ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                },
                "Failed to reschedule active turn continuation",
              );
              throw error;
            }

            await postTurnContinuationNotice();
            markConversationMessage(
              preparedState.conversation,
              preparedState.userMessageId,
              {
                replied: true,
                skippedReason: undefined,
              },
            );
            await persistThreadState(thread, {
              conversation: preparedState.conversation,
            });
            return;
          }
        }
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats,
        });
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

        const fallbackIdentity = await deps.services.lookupSlackUser(
          message.author.userId,
        );
        const resolvedUserName =
          message.author.userName ?? fallbackIdentity?.userName;
        if (resolvedUserName) {
          setTags({ slackUserName: resolvedUserName });
        }
        const userAttachments = await deps.resolveUserAttachments(
          message.attachments,
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
          !isVisionEnabled() && hasPotentialImageAttachment(message.attachments)
            ? countPotentialImageAttachments(message.attachments)
            : 0;

        const status = createSlackAdapterAssistantStatusSession({
          channelId: assistantThreadContext?.channelId,
          threadTs: assistantThreadContext?.threadTs,
          getSlackAdapter: deps.getSlackAdapter,
        });
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
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;

        try {
          const toolChannelId =
            preparedState.artifacts.assistantContextChannelId ?? channelId;
          let reply = await deps.services.generateAssistantReply(userText, {
            requester: {
              userId: message.author.userId,
              userName: message.author.userName ?? fallbackIdentity?.userName,
              fullName: message.author.fullName ?? fallbackIdentity?.fullName,
            },
            conversationContext:
              preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            piMessages: preparedState.conversation.piMessages,
            pendingAuth: preparedState.conversation.processing.pendingAuth,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
            inboundAttachmentCount: message.attachments.length,
            omittedImageAttachmentCount,
            userAttachments,
            correlation: {
              conversationId,
              threadId,
              turnId,
              threadTs,
              messageTs,
              runId,
              channelId,
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
          });
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
            text: normalizeConversationText(reply.text) || "[empty response]",
            createdAtMs: Date.now(),
            author: {
              userName: botConfig.userName,
              isBot: true,
            },
            meta: {
              replied: true,
            },
          });
          if (reply.piMessages) {
            preparedState.conversation.piMessages = reply.piMessages;
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
              titleUpdateResult;
          }

          const shouldPersistArtifacts =
            Object.keys(artifactStatePatch).length > 0;
          const nextArtifacts = shouldPersistArtifacts
            ? mergeArtifactsState(preparedState.artifacts, artifactStatePatch)
            : undefined;
          // Live turn owns the in-memory conversation; `sessionId` is omitted
          // so `activeTurnId` clears unconditionally. Callback paths that
          // reload thread state fresh must pass `sessionId` to avoid wiping a
          // concurrent turn's active id.
          markTurnCompleted({
            conversation: preparedState.conversation,
            nowMs: Date.now(),
            updateConversationStats,
          });
          await persistThreadState(thread, {
            artifacts: nextArtifacts,
            conversation: preparedState.conversation,
            sandboxId: reply.sandboxId,
            sandboxDependencyProfileHash: reply.sandboxDependencyProfileHash,
          });
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
        } catch (error) {
          if (
            isRetryableTurnError(error, "mcp_auth_resume") ||
            isRetryableTurnError(error, "plugin_auth_resume")
          ) {
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
            const checkpointVersion = error.metadata?.checkpointVersion;
            const nextSliceId = error.metadata?.sliceId;
            if (
              conversationIdForResume &&
              sessionIdForResume &&
              typeof checkpointVersion === "number" &&
              canScheduleTurnTimeoutResume(nextSliceId)
            ) {
              try {
                await deps.services.scheduleTurnTimeoutResume({
                  conversationId: conversationIdForResume,
                  sessionId: sessionIdForResume,
                  expectedCheckpointVersion: checkpointVersion,
                });
                shouldPersistFailureState = false;
              } catch (scheduleError) {
                logException(
                  scheduleError,
                  "agent_turn_timeout_resume_schedule_failed",
                  turnTraceContext,
                  {
                    ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                    "app.ai.resume_checkpoint_version": checkpointVersion,
                  },
                  "Failed to schedule timeout resume callback",
                );
                shouldPersistFailureState = true;
                throw scheduleError;
              }
              await postTurnContinuationNotice();
              return;
            } else if (
              conversationIdForResume &&
              sessionIdForResume &&
              typeof checkpointVersion === "number"
            ) {
              logWarn(
                "agent_turn_timeout_resume_slice_limit_reached",
                turnTraceContext,
                {
                  ...(messageTs ? { "messaging.message.id": messageTs } : {}),
                  ...(typeof nextSliceId === "number"
                    ? { "app.ai.resume_slice_id": nextSliceId }
                    : {}),
                },
                "Skipped automatic timeout resume because the turn exceeded the slice limit",
              );
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
          throw error;
        } finally {
          if (!persistedAtLeastOnce && shouldPersistFailureState) {
            markTurnFailed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              userMessageId: preparedState.userMessageId,
              markConversationMessage: (conversation, messageId, patch) => {
                markConversationMessage(conversation, messageId, patch);
              },
              updateConversationStats,
            });
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
