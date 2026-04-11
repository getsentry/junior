import type { SlackAdapter } from "@chat-adapter/slack";
import {
  createSlackTurnRuntime,
  type AssistantLifecycleEvent,
  type SlackTurnRuntime,
} from "@/chat/runtime/slack-runtime";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  logException,
  logWarn,
  resolveErrorReference,
  withSpan,
} from "@/chat/logging";
import { createReplyToThread } from "@/chat/runtime/reply-executor";
import { initializeAssistantThread as initializeAssistantThreadImpl } from "@/chat/runtime/assistant-lifecycle";
import {
  getChannelId,
  getRunId,
  getThreadId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { persistThreadState } from "@/chat/runtime/thread-state";
import {
  createPrepareTurnState,
  type PreparedTurnState,
} from "@/chat/runtime/turn-preparation";
import {
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { botConfig } from "@/chat/config";
import { getSlackMessageTs } from "@/chat/slack/message";

export interface CreateSlackRuntimeOptions {
  getSlackAdapter: () => SlackAdapter;
  now?: () => number;
  services?: JuniorRuntimeServiceOverrides;
}

export function createSlackRuntime(
  options: CreateSlackRuntimeOptions,
): SlackTurnRuntime<PreparedTurnState, AssistantLifecycleEvent> {
  const services = createJuniorRuntimeServices(options.services);
  const prepareTurnState = createPrepareTurnState({
    compactConversationIfNeeded:
      services.conversationMemory.compactConversationIfNeeded,
    hydrateConversationVisionContext:
      services.visionContext.hydrateConversationVisionContext,
  });
  const replyToThread = createReplyToThread({
    getSlackAdapter: options.getSlackAdapter,
    prepareTurnState,
    resolveUserAttachments: services.visionContext.resolveUserAttachments,
    services: services.replyExecutor,
  });

  return createSlackTurnRuntime<PreparedTurnState, AssistantLifecycleEvent>({
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
    now: options.now ?? (() => Date.now()),
    getErrorReference: resolveErrorReference,
    getThreadId,
    getChannelId,
    getRunId,
    stripLeadingBotMention,
    withSpan,
    logWarn,
    logException,
    prepareTurnState,
    persistPreparedState: async ({ thread, preparedState }) => {
      await persistThreadState(thread, {
        conversation: preparedState.conversation,
      });
    },
    getPreparedConversationContext: (preparedState) =>
      preparedState.routingContext ?? preparedState.conversationContext,
    decideSubscribedReply: services.subscribedReplyPolicy,
    recordSkippedSubscribedMessage: async ({
      thread,
      message,
      decision,
      completedAtMs,
      userText,
    }) => {
      const conversation = coerceThreadConversationState(await thread.state);
      const normalizedUserText =
        normalizeConversationText(userText) || "[non-text message]";
      const slackTs = getSlackMessageTs(message);
      upsertConversationMessage(conversation, {
        id: message.id,
        role: "user",
        text: normalizedUserText,
        createdAtMs: message.metadata.dateSent.getTime(),
        author: {
          userId: message.author.userId,
          userName: message.author.userName,
          fullName: message.author.fullName,
          isBot:
            typeof message.author.isBot === "boolean"
              ? message.author.isBot
              : undefined,
        },
        meta: {
          explicitMention: Boolean(message.isMention),
          slackTs,
          replied: false,
          skippedReason: decision.reason,
          imagesHydrated: true,
        },
      });
      conversation.processing.activeTurnId = undefined;
      conversation.processing.lastCompletedAtMs = completedAtMs;
      updateConversationStats(conversation);
      await persistThreadState(thread, {
        conversation,
      });
    },
    onSubscribedMessageSkipped: async ({
      thread,
      preparedState,
      decision,
      completedAtMs,
    }) => {
      if (!preparedState) {
        return;
      }
      markConversationMessage(
        preparedState.conversation,
        preparedState.userMessageId,
        {
          replied: false,
          skippedReason: decision.reason,
        },
      );
      preparedState.conversation.processing.activeTurnId = undefined;
      preparedState.conversation.processing.lastCompletedAtMs = completedAtMs;
      updateConversationStats(preparedState.conversation);
      await persistThreadState(thread, {
        conversation: preparedState.conversation,
      });
    },
    replyToThread,
    initializeAssistantThread: async ({
      threadId,
      channelId,
      threadTs,
      sourceChannelId,
    }) => {
      await initializeAssistantThreadImpl({
        threadId,
        channelId,
        threadTs,
        sourceChannelId,
        getSlackAdapter: options.getSlackAdapter,
      });
    },
  });
}
