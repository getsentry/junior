import type { Message, SentMessage, Thread } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
import { isExplicitChannelPostIntent } from "@/chat/channel-intent";
import { logError, logException, logInfo, logWarn, setSpanAttributes, setTags, withSpan } from "@/chat/observability";
import { buildSlackOutputMessage, ensureBlockSpacing } from "@/chat/output";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { createProgressReporter } from "@/chat/progress-reporter";
import { getBotDeps } from "@/chat/runtime/deps";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { createTextStreamBridge, createNormalizingStream } from "@/chat/runtime/streaming";
import { getChannelId, getMessageTs, getSlackApiErrorCode, getThreadId, getThreadTs, getRunId, isSlackTitlePermissionError, stripLeadingBotMention } from "@/chat/runtime/thread-context";
import { persistThreadState, mergeArtifactsState } from "@/chat/runtime/thread-state";
import type { PreparedTurnState } from "@/chat/runtime/turn-preparation";
import { generateThreadTitle, markConversationMessage, normalizeConversationText, upsertConversationMessage, generateConversationId, updateConversationStats } from "@/chat/services/conversation-memory";
import { resolveUserAttachments } from "@/chat/services/vision-context";
import { isDmChannel } from "@/chat/slack-actions/client";
import { type ThreadArtifactsState } from "@/chat/slack-actions/types";
import { resolveReplyDelivery } from "@/chat/turn/execute";
import { markTurnCompleted, markTurnFailed } from "@/chat/turn/persist";
import { startActiveTurn } from "@/chat/turn/prepare";

function buildDeterministicTurnId(messageId: string): string {
  const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `turn_${sanitized}`;
}

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
      runId?: string;
    };
  }) => Promise<PreparedTurnState>;
}

export function createReplyToThread(deps: ReplyExecutorDeps) {
  return async function replyToThread(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
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
              runId
            }
          }));

        const turnId = buildDeterministicTurnId(message.id);
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats
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
          modelId: botConfig.modelId
        };
        setTags({
          conversationId,
          turnId,
          agentId: turnId
        });
        if (shouldEmitDevAgentTrace()) {
          logInfo(
            "agent_turn_started",
            turnTraceContext,
            {
              "app.message.id": message.id,
              ...(messageTs ? { "messaging.message.id": messageTs } : {})
            },
            "Agent turn started"
          );
        }
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
          runId
        });

        const progress = createProgressReporter({
          channelId,
          threadTs,
          setAssistantStatus: (channel, thread, text, suggestions) =>
            deps.getSlackAdapter().setAssistantStatus(channel, thread, text, suggestions)
        });
        const textStream = createTextStreamBridge();
        let streamedReplyPromise: Promise<SentMessage> | undefined;
        let beforeFirstResponsePostCalled = false;
        const beforeFirstResponsePost = async (): Promise<void> => {
          if (beforeFirstResponsePostCalled) {
            return;
          }
          beforeFirstResponsePostCalled = true;
          await options.beforeFirstResponsePost?.();
        };
        const startStreamingReply = () => {
          if (!streamedReplyPromise) {
            const streamingReply = (async () => {
              await beforeFirstResponsePost();
              return await thread.post(
                createNormalizingStream(textStream.iterable, ensureBlockSpacing)
              );
            })();
            streamedReplyPromise = streamingReply;
          }
        };
        const postThreadReply = async (payload: Parameters<typeof thread.post>[0]): Promise<unknown> => {
          await beforeFirstResponsePost();
          return await thread.post(payload);
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
              conversationId,
              threadId,
              turnId,
              threadTs,
              messageTs,
              runId,
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
            runId,
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
              await postThreadReply(
                buildSlackOutputMessage(reply.text, {
                  files: resolvedAttachFiles === "inline" ? replyFiles : undefined
                })
              );
            } else {
              await streamedReplyPromise;
              if (reply.diagnostics.outcome !== "success" && reply.text.trim().length > 0) {
                await postThreadReply(buildSlackOutputMessage(reply.text));
              }
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
          if (shouldEmitDevAgentTrace()) {
            logInfo(
              "agent_turn_completed",
              turnTraceContext,
              {
                "app.turn.duration_ms": Date.now() - turnStartedAtMs,
                "app.ai.outcome": reply.diagnostics.outcome,
                "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
                "app.ai.tool_error_results": reply.diagnostics.toolErrorCount
              },
              "Agent turn completed"
            );
          }

          const isFirstAssistantReply =
            preparedState.conversation.stats.compactedMessageCount === 0 &&
            preparedState.conversation.messages.filter((m) => m.role === "assistant").length === 1;
          if (isFirstAssistantReply && channelId && isDmChannel(channelId) && threadTs) {
            void generateThreadTitle(userText, reply.text)
              .then((title) => deps.getSlackAdapter().setAssistantTitle(channelId, threadTs, title))
              .catch((error) => {
                const slackErrorCode = getSlackApiErrorCode(error);
                const assistantTitleErrorAttributes = {
                  "app.slack.assistant_title.outcome": "permission_denied",
                  ...(slackErrorCode ? { "app.slack.assistant_title.error_code": slackErrorCode } : {})
                };
                if (isSlackTitlePermissionError(error)) {
                  setSpanAttributes(assistantTitleErrorAttributes);
                  logError(
                    "thread_title_generation_permission_denied",
                    {
                      slackThreadId: threadId,
                      slackUserId: message.author.userId,
                      slackChannelId: channelId,
                      runId,
                      assistantUserName: botConfig.userName,
                      modelId: botConfig.fastModelId
                    },
                    assistantTitleErrorAttributes,
                    "Skipping thread title update due to Slack permission error"
                  );
                  return;
                }

                logWarn(
                  "thread_title_generation_failed",
                  {
                    slackThreadId: threadId,
                    slackUserId: message.author.userId,
                    slackChannelId: channelId,
                    runId,
                    assistantUserName: botConfig.userName,
                    modelId: botConfig.fastModelId
                  },
                  { "error.message": error instanceof Error ? error.message : String(error) },
                  "Thread title generation failed"
                );
              });
          }

          if (shouldPostThreadReply && resolvedAttachFiles === "followup" && replyFiles) {
            await postThreadReply({ files: replyFiles } as Parameters<typeof thread.post>[0]);
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
            if (shouldEmitDevAgentTrace()) {
              logWarn(
                "agent_turn_failed",
                turnTraceContext,
                {
                  "app.turn.duration_ms": Date.now() - turnStartedAtMs
                },
                "Agent turn failed"
              );
            }
          }
          await progress.stop();
        }
      }
    );
  };
}
