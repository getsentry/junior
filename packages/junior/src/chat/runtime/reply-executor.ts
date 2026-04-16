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
  type PlannedSlackReplyStage,
} from "@/chat/slack/reply";
import { buildSlackOutputMessage } from "@/chat/slack/output";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  getAssistantThreadContext,
  getChannelId,
  getMessageTs,
  getSlackErrorObservabilityAttributes,
  getThreadId,
  getThreadTs,
  getRunId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import {
  persistThreadState,
  mergeArtifactsState,
} from "@/chat/runtime/thread-state";
import { buildThreadParticipants } from "@/chat/runtime/thread-participants";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  generateThreadTitle,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  generateConversationId,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { createSlackAdapterAssistantStatusSession } from "@/chat/slack/assistant-thread/status";
import { maybeUpdateAssistantTitle } from "@/chat/slack/assistant-thread/title";
import { type ThreadArtifactsState } from "@/chat/state/artifacts";
import { lookupSlackUser } from "@/chat/slack/user";
import type { TurnTimeoutResumeRequest } from "@/chat/services/timeout-resume";
import { canScheduleTurnTimeoutResume } from "@/chat/services/timeout-resume";
import { isRetryableTurnError } from "@/chat/runtime/turn";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import { startActiveTurn } from "@/chat/runtime/turn";
import { isRedundantReactionAckText } from "@/chat/services/reply-delivery-plan";

export interface ReplyExecutorServices {
  generateAssistantReply: typeof generateAssistantReplyImpl;
  generateThreadTitle: typeof generateThreadTitle;
  lookupSlackUser: typeof lookupSlackUser;
  scheduleTurnTimeoutResume: (
    request: TurnTimeoutResumeRequest,
  ) => Promise<void>;
}

function getExecutionFailureReason(reply: {
  diagnostics: {
    assistantMessageCount: number;
    errorMessage?: string;
    toolErrorCount: number;
  };
}): string {
  const errorMessage = reply.diagnostics.errorMessage?.trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (reply.diagnostics.toolErrorCount > 0) {
    return `${reply.diagnostics.toolErrorCount} tool result error(s)`;
  }
  if (reply.diagnostics.assistantMessageCount > 0) {
    return "assistant returned no text";
  }
  return "empty assistant turn";
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
        const userText = stripLeadingBotMention(message.text, {
          stripLeadingSlackMentionToken:
            options.explicitMention || Boolean(message.isMention),
        });

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
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats,
        });
        const turnStartedAtMs = Date.now();
        const turnTraceContext = {
          conversationId,
          turnId,
          agentId: turnId,
          slackThreadId: threadId,
          slackUserId: message.author.userId,
          slackChannelId: channelId,
          runId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId,
        };
        setTags({
          conversationId,
          turnId,
          agentId: turnId,
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

        const status = createSlackAdapterAssistantStatusSession({
          channelId: assistantThreadContext?.channelId,
          threadTs: assistantThreadContext?.threadTs,
          getSlackAdapter: deps.getSlackAdapter,
        });
        let beforeFirstResponsePostCalled = false;
        const beforeFirstResponsePost = async (): Promise<void> => {
          if (beforeFirstResponsePostCalled) {
            return;
          }
          beforeFirstResponsePostCalled = true;
          await options.beforeFirstResponsePost?.();
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
        status.start();
        const assistantTitleTask = maybeUpdateAssistantTitle({
          assistantThreadContext,
          assistantUserName: botConfig.userName,
          artifacts: preparedState.artifacts,
          channelId,
          conversation: preparedState.conversation,
          generateThreadTitle: deps.services.generateThreadTitle,
          getSlackAdapter: deps.getSlackAdapter,
          modelId: botConfig.lightModelId,
          requesterId: message.author.userId,
          runId,
          threadId,
        });
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;

        try {
          const toolChannelId =
            preparedState.artifacts.assistantContextChannelId ?? channelId;
          const threadParticipants = buildThreadParticipants(
            preparedState.conversation.messages,
          );
          const reply = await deps.services.generateAssistantReply(userText, {
            assistant: {
              userName: botConfig.userName,
            },
            requester: {
              userId: message.author.userId,
              userName: message.author.userName ?? fallbackIdentity?.userName,
              fullName: message.author.fullName ?? fallbackIdentity?.fullName,
            },
            conversationContext:
              preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
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
            threadParticipants,
            onStatus: (nextStatus) => status.update(nextStatus),
          });
          const diagnosticsContext = {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          };
          const diagnosticsAttributes = {
            "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
            "gen_ai.operation.name": "invoke_agent",
            "app.ai.outcome": reply.diagnostics.outcome,
            "app.ai.assistant_messages":
              reply.diagnostics.assistantMessageCount,
            "app.ai.tool_results": reply.diagnostics.toolResultCount,
            "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
            "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
            "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
            ...(reply.diagnostics.stopReason
              ? {
                  "gen_ai.response.finish_reasons": [
                    reply.diagnostics.stopReason,
                  ],
                }
              : {}),
            ...(reply.diagnostics.errorMessage
              ? { "error.message": reply.diagnostics.errorMessage }
              : {}),
          };
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome === "provider_error") {
            const providerError =
              reply.diagnostics.providerError ??
              new Error(
                reply.diagnostics.errorMessage ??
                  "Provider error without explicit message",
              );
            logException(
              providerError,
              "agent_turn_provider_error",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn failed with provider error",
            );
          } else if (reply.diagnostics.outcome !== "success") {
            const failureReason = getExecutionFailureReason(reply);
            logException(
              new Error(`Agent turn execution failure: ${failureReason}`),
              "agent_turn_execution_failure",
              diagnosticsContext,
              {
                ...diagnosticsAttributes,
                "app.ai.execution_failure_reason": failureReason,
              },
              "Agent turn completed with execution failure",
            );
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

          const artifactStatePatch: Partial<ThreadArtifactsState> =
            reply.artifactStatePatch ? { ...reply.artifactStatePatch } : {};

          const reactionPerformed = reply.diagnostics.toolCalls.includes(
            "slackMessageAddReaction",
          );
          const plannedPosts = planSlackReplyPosts({ reply });

          // Final Slack delivery is part of turn success. We only mark the turn
          // completed after the visible reply has been accepted by Slack.
          if (plannedPosts.length > 0) {
            let sent: SentMessage | undefined;
            for (const post of plannedPosts) {
              sent = await postThreadReply(
                buildSlackOutputMessage(post.text, post.files),
                post.stage,
              );
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
                "app.turn.duration_ms": Date.now() - turnStartedAtMs,
                "app.ai.outcome": reply.diagnostics.outcome,
                "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
                "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
              },
              "Agent turn completed",
            );
          }
        } catch (error) {
          if (isRetryableTurnError(error, "mcp_auth_resume")) {
            shouldPersistFailureState = false;
            throw error;
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
                return;
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
              }
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
                {
                  "app.turn.duration_ms": Date.now() - turnStartedAtMs,
                },
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
