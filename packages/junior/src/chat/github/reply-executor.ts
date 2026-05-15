import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import {
  buildTurnFailureResponse,
  logException,
  setSpanAttributes,
  setTags,
  withSpan,
} from "@/chat/logging";
import { GITHUB_COMMENT_SURFACE } from "@/chat/surface";
import { applyPendingAuthUpdate } from "@/chat/services/pending-auth";
import {
  finalizeFailedTurnReply,
  getAgentTurnDiagnosticsAttributes,
} from "@/chat/services/turn-failure-response";
import {
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { type PreparedTurnState } from "@/chat/runtime/turn-preparation";
import {
  buildDeterministicTurnId,
  isRetryableTurnError,
  markTurnCompleted,
  markTurnFailed,
  startActiveTurn,
} from "@/chat/runtime/turn";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import { getRunId, getThreadId, stripLeadingBotMention } from "@/chat/runtime/thread-context";
import { mergeArtifactsState, persistThreadState } from "@/chat/runtime/thread-state";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";

export interface GitHubReplyExecutorServices {
  generateAssistantReply: typeof generateAssistantReplyImpl;
}

interface GitHubReplyExecutorDeps {
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
  services: GitHubReplyExecutorServices;
}

export function createReplyToGitHubThread(deps: GitHubReplyExecutorDeps) {
  return async function replyToGitHubThread(
    thread: Thread,
    message: Message,
    options: {
      beforeFirstResponsePost?: () => Promise<void>;
      explicitMention?: boolean;
      preparedState?: PreparedTurnState;
    } = {},
  ): Promise<void> {
    if (message.author.isMe) {
      return;
    }

    const threadId = getThreadId(thread, message);
    const runId = getRunId(thread, message);
    const conversationId = threadId ?? runId;

    await withSpan(
      "chat.reply",
      "chat.reply",
      {
        conversationId,
        runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      async () => {
        const strippedUserText = stripLeadingBotMention(message.text, {
          stripLeadingSlackMentionToken: false,
        });
        const userText = strippedUserText || message.text;
        const preparedState =
          options.preparedState ??
          (await deps.prepareTurnState({
            thread,
            message,
            userText,
            explicitMention: Boolean(
              options.explicitMention ?? message.isMention ?? true,
            ),
            context: {
              threadId,
              requesterId: message.author.userId,
              channelId: undefined,
              runId,
            },
          }));
        const turnId = buildDeterministicTurnId(message.id);
        startActiveTurn({
          conversation: preparedState.conversation,
          nextTurnId: turnId,
          updateConversationStats,
        });
        setTags({
          conversationId,
        });
        await persistThreadState(thread, {
          conversation: preparedState.conversation,
        });

        let beforeFirstResponsePostCalled = false;
        const beforeFirstResponsePost = async (): Promise<void> => {
          if (beforeFirstResponsePostCalled) {
            return;
          }
          beforeFirstResponsePostCalled = true;
          await options.beforeFirstResponsePost?.();
        };
        let persistedAtLeastOnce = false;
        let shouldPersistFailureState = true;

        try {
          let reply = await deps.services.generateAssistantReply(userText, {
            surface: GITHUB_COMMENT_SURFACE,
            requester: {
              userId: message.author.userId,
              userName: message.author.userName,
              fullName: message.author.fullName,
            },
            conversationContext:
              preparedState.routingContext ?? preparedState.conversationContext,
            artifactState: preparedState.artifacts,
            piMessages: preparedState.conversation.piMessages,
            pendingAuth: preparedState.conversation.processing.pendingAuth,
            configuration: preparedState.configuration,
            channelConfiguration: preparedState.channelConfiguration,
            inboundAttachmentCount: message.attachments.length,
            correlation: {
              conversationId,
              threadId,
              turnId,
              runId,
              requesterId: message.author.userId,
            },
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
          });

          setSpanAttributes(getAgentTurnDiagnosticsAttributes(reply));
          if (reply.diagnostics.outcome !== "success") {
            reply = finalizeFailedTurnReply({
              reply,
              logException,
              context: {
                conversationId,
                runId,
                assistantUserName: botConfig.userName,
                modelId: reply.diagnostics.modelId,
              },
              attributes: {
                "app.surface.platform": "github",
              },
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

          const deliveryText =
            normalizeConversationText(reply.text) ||
            "I couldn't produce a text response for this turn.";

          await beforeFirstResponsePost();
          await thread.post(deliveryText);

          const artifactStatePatch = reply.artifactStatePatch
            ? { ...reply.artifactStatePatch }
            : {};
          const nextArtifacts =
            Object.keys(artifactStatePatch).length > 0
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

          const eventId = logException(
            error,
            "github_turn_reply_failed",
            {
              conversationId,
              runId,
              assistantUserName: botConfig.userName,
              modelId: botConfig.modelId,
            },
            {
              "app.surface.platform": "github",
            },
            "GitHub turn reply failed",
          );
          if (!eventId) {
            throw new Error(
              "Sentry did not return an event ID for github_turn_reply_failed",
            );
          }

          await beforeFirstResponsePost();
          try {
            await thread.post(buildTurnFailureResponse(eventId));
          } catch (fallbackError) {
            logException(
              fallbackError,
              "github_turn_failure_reply_post_failed",
              {
                conversationId,
                runId,
                assistantUserName: botConfig.userName,
                modelId: botConfig.modelId,
              },
              {
                "app.error.original_event_id": eventId,
                "app.surface.platform": "github",
              },
              "Failed to post GitHub fallback reply",
            );
            throw fallbackError;
          }
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
          }
        }
      },
    );
  };
}
