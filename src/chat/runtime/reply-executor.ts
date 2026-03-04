import type { Message, SentMessage, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { isExplicitChannelPostIntent } from "@/chat/channel-intent";
import { logException, logWarn, setSpanAttributes, setTags, withSpan } from "@/chat/observability";
import { buildSlackOutputMessage, ensureBlockSpacing } from "@/chat/output";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { createProgressReporter } from "@/chat/progress-reporter";
import { getBotDeps } from "@/chat/runtime/deps";
import { createTextStreamBridge, createNormalizingStream } from "@/chat/runtime/streaming";
import { getChannelId, getMessageTs, getSlackApiErrorCode, getThreadId, getThreadTs, getWorkflowRunId, isSlackTitlePermissionError, stripLeadingBotMention } from "@/chat/runtime/thread-context";
import { persistThreadState, mergeArtifactsState } from "@/chat/runtime/thread-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import { generateThreadTitle, markConversationMessage, normalizeConversationText, upsertConversationMessage, generateConversationId, updateConversationStats } from "@/chat/services/conversation-memory";
import { resolveUserAttachments } from "@/chat/services/vision-context";
import { isDmChannel } from "@/chat/slack-actions/client";
import { type ThreadArtifactsState } from "@/chat/slack-actions/types";
import { resolveReplyDelivery } from "@/chat/turn/execute";
import { markTurnCompleted, markTurnFailed } from "@/chat/turn/persist";
import { startActiveTurn } from "@/chat/turn/prepare";

interface ReplyExecutorDeps {
  getSlackAdapter: () => SlackAdapter;
  prepareTurnState: (args: {
    explicitMention: boolean;
    message: Message;
    thread: Thread;
    userText: string;
    context: {
      threadId?: string;
      requesterId?: string;
      channelId?: string;
      workflowRunId?: string;
    };
  }) => Promise<PreparedTurnState>;
}

export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
    thread: Thread,
    message: Message,
    options: {
      explicitMention?: boolean;
      preparedState?: PreparedTurnState;
    } = {}
  ) {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const channelId = getChannelId(thread, message);
    const threadTs = getThreadTs(threadId);
    const messageTs = getMessageTs(message);
    const workflowRunId = getWorkflowRunId(thread, message);

    await withSpan(
      "workflow.reply",
      "workflow.reply",
      {
        slackThreadId: threadId,
        slackUserId: message.author.userId,
        slackChannelId: channelId,
        workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      async () => {
        const userText = stripLeadingBotMention(message.text, {
          stripLeadingSlackMentionToken: options.explicitMention || Boolean(message.isMention)
        });
        const explicitChannelPostIntent = isExplicitChannelPostIntent(userText);

        const preparedState =
          options.preparedState ??
          (await deps.prepareTurnState({
            thread,
            message,
            userText,
            explicitMention: Boolean(options.explicitMention || message.isMention),
            context: {
              threadId,
              requesterId: message.author.userId,
              channelId,
              workflowRunId
            }
          }));

        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: generateConversationId("turn"),
          updateConversationStats
        });
        await persistThreadState(thread, {
          conversation: preparedState.conversation
        });

        const fallbackIdentity = await getBotDeps().lookupSlackUser(message.author.userId);
        const resolvedUserName = message.author.userName ?? fallbackIdentity?.userName;
        if (resolvedUserName) {
          setTags({ slackUserName: resolvedUserName });
        }
        const userAttachments = await resolveUserAttachments(message.attachments, {
          threadId,
          requesterId: message.author.userId,
          channelId,
          workflowRunId
        });

        const progress = createProgressReporter({
          channelId,
          threadTs,
          setAssistantStatus: (channel, thread, text, suggestions) =>
            deps.getSlackAdapter().setAssistantStatus(channel, thread, text, suggestions)
        });
        const textStream = createTextStreamBridge();
        let streamedReplyPromise: Promise<SentMessage> | undefined;
        const startStreamingReply = () => {
          if (!streamedReplyPromise) {
            streamedReplyPromise = thread.post(
              createNormalizingStream(textStream.iterable, ensureBlockSpacing)
            );
          }
        };
        await progress.start();
        let persistedAtLeastOnce = false;

        try {
          const toolChannelId = preparedState.artifacts.assistantContextChannelId ?? channelId;
          const reply = await getBotDeps().generateAssistantReply(userText, {
            assistant: {
              userName: botConfig.userName
            },
            requester: {
              userId: message.author.userId,
              userName: message.author.userName ?? fallbackIdentity?.userName,
              fullName: message.author.fullName ?? fallbackIdentity?.fullName
            },
            conversationContext: preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
            userAttachments,
            correlation: {
              threadId,
              threadTs,
              messageTs,
              workflowRunId,
              channelId,
              requesterId: message.author.userId
            },
            toolChannelId,
            sandbox: {
              sandboxId: preparedState.sandboxId
            },
            onStatus: (status) => progress.setStatus(status),
            onTextDelta: (deltaText) => {
              if (explicitChannelPostIntent) {
                return;
              }
              startStreamingReply();
              textStream.push(deltaText);
            }
          });
          textStream.end();
          const diagnosticsContext = {
            slackThreadId: threadId,
            slackUserId: message.author.userId,
            slackChannelId: channelId,
            workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          };
          const diagnosticsAttributes = {
            "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
            "gen_ai.operation.name": "invoke_agent",
            "app.ai.outcome": reply.diagnostics.outcome,
            "app.ai.assistant_messages": reply.diagnostics.assistantMessageCount,
            "app.ai.tool_results": reply.diagnostics.toolResultCount,
            "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
            "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
            "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
            ...(reply.diagnostics.stopReason
              ? { "app.ai.stop_reason": reply.diagnostics.stopReason }
              : {}),
            ...(reply.diagnostics.errorMessage
              ? { "error.message": reply.diagnostics.errorMessage }
              : {})
          };
          setSpanAttributes(diagnosticsAttributes);
          if (reply.diagnostics.outcome === "provider_error") {
            const providerError =
              reply.diagnostics.providerError ??
              new Error(reply.diagnostics.errorMessage ?? "Provider error without explicit message");
            logException(
              providerError,
              "agent_turn_provider_error",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn failed with provider error"
            );
          } else if (reply.diagnostics.outcome !== "success") {
            logWarn(
              "agent_turn_diagnostics",
              diagnosticsContext,
              diagnosticsAttributes,
              "Agent turn completed with execution failure"
            );
          }

          markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
            replied: true,
            skippedReason: undefined
          });

          upsertConversationMessage(preparedState.conversation, {
            id: generateConversationId("assistant"),
            role: "assistant",
            text: normalizeConversationText(reply.text) || "[empty response]",
            createdAtMs: Date.now(),
            author: {
              userName: botConfig.userName,
              isBot: true
            },
            meta: {
              replied: true
            }
          });

          const artifactStatePatch: Partial<ThreadArtifactsState> = reply.artifactStatePatch
            ? { ...reply.artifactStatePatch }
            : {};

          const replyFiles = reply.files && reply.files.length > 0 ? reply.files : undefined;
          const { shouldPostThreadReply, attachFiles: resolvedAttachFiles } = resolveReplyDelivery({
            reply,
            hasStreamedThreadReply: Boolean(streamedReplyPromise)
          });

          if (shouldPostThreadReply) {
            if (!streamedReplyPromise) {
              await thread.post(
                buildSlackOutputMessage(reply.text, {
                  files: resolvedAttachFiles === "inline" ? replyFiles : undefined
                })
              );
            } else {
              await streamedReplyPromise;
            }
          }

          const shouldPersistArtifacts = Object.keys(artifactStatePatch).length > 0;
          const nextArtifacts = shouldPersistArtifacts
            ? mergeArtifactsState(preparedState.artifacts, artifactStatePatch)
            : undefined;
          markTurnCompleted({
            conversation: preparedState.conversation,
            nowMs: Date.now(),
            updateConversationStats
          });
          await persistThreadState(thread, {
            artifacts: nextArtifacts,
            conversation: preparedState.conversation,
            sandboxId: reply.sandboxId
          });
          persistedAtLeastOnce = true;

          const isFirstAssistantReply =
            preparedState.conversation.stats.compactedMessageCount === 0 &&
            preparedState.conversation.messages.filter((m) => m.role === "assistant").length === 1;
          if (isFirstAssistantReply && channelId && isDmChannel(channelId) && threadTs) {
            void generateThreadTitle(userText, reply.text)
              .then((title) => deps.getSlackAdapter().setAssistantTitle(channelId, threadTs, title))
              .catch((error) => {
                const slackErrorCode = getSlackApiErrorCode(error);
                if (isSlackTitlePermissionError(error)) {
                  setSpanAttributes({
                    "app.slack.assistant_title.outcome": "permission_denied",
                    ...(slackErrorCode ? { "app.slack.assistant_title.error_code": slackErrorCode } : {})
                  });
                  return;
                }

                logWarn(
                  "thread_title_generation_failed",
                  {
                    slackThreadId: threadId,
                    slackUserId: message.author.userId,
                    slackChannelId: channelId,
                    workflowRunId,
                    assistantUserName: botConfig.userName,
                    modelId: botConfig.fastModelId
                  },
                  { "error.message": error instanceof Error ? error.message : String(error) },
                  "Thread title generation failed"
                );
              });
          }

          if (shouldPostThreadReply && resolvedAttachFiles === "followup" && replyFiles) {
            await thread.post({ files: replyFiles } as Parameters<typeof thread.post>[0]);
          }
        } finally {
          textStream.end();
          if (!persistedAtLeastOnce) {
            markTurnFailed({
              conversation: preparedState.conversation,
              nowMs: Date.now(),
              userMessageId: preparedState.userMessageId,
              markConversationMessage: (conversation, messageId, patch) => {
                markConversationMessage(conversation, messageId, patch);
              },
              updateConversationStats
            });
            await persistThreadState(thread, {
              conversation: preparedState.conversation
            });
          }
          await progress.stop();
        }
      }
    );
  };
}
