import type { SlackAdapter } from "@chat-adapter/slack";
import {
  createSlackTurnRuntime,
  type AssistantLifecycleEvent,
  type SlackTurnRuntime,
} from "@/chat/runtime/slack-runtime";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { logException, logWarn, withSpan } from "@/chat/logging";
import { createReplyToThread } from "@/chat/runtime/reply-executor";
import {
  initializeAssistantThread as initializeAssistantThreadImpl,
  refreshAssistantThreadContext as refreshAssistantThreadContextImpl,
} from "@/chat/slack/assistant-thread/lifecycle";
import {
  getChannelId,
  getRunId,
  getThreadId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import {
  getPersistedThreadState,
  mergeArtifactsState,
  persistThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  createPrepareTurnState,
  type PreparedTurnState,
} from "@/chat/runtime/turn-preparation";
import { toConversationMessage } from "@/chat/runtime/conversation-message";
import {
  markConversationMessage,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { botConfig } from "@/chat/config";

export interface CreateSlackRuntimeOptions {
  getSlackAdapter: () => SlackAdapter;
  now?: () => number;
  services?: JuniorRuntimeServiceOverrides;
}

async function persistAssistantContextChannelId(args: {
  sourceChannelId: string;
  threadId: string;
}): Promise<void> {
  const currentArtifacts = coerceThreadArtifactsState(
    await getPersistedThreadState(args.threadId),
  );
  const nextArtifacts = mergeArtifactsState(currentArtifacts, {
    assistantContextChannelId: args.sourceChannelId,
  });
  await persistThreadStateById(args.threadId, {
    artifacts: nextArtifacts,
  });
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
      text,
    }) => {
      const conversation = coerceThreadConversationState(await thread.state);
      const conversationMessage = toConversationMessage({
        entry: message,
        explicitMention: Boolean(message.isMention),
        text: text.userText,
      });
      upsertConversationMessage(conversation, {
        ...conversationMessage,
        meta: {
          ...conversationMessage.meta,
          replied: false,
          skippedReason: decision.reason,
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
        channelId,
        threadTs,
        sourceChannelId,
        getSlackAdapter: options.getSlackAdapter,
        onContextChannelResolved: (resolvedSourceChannelId) =>
          persistAssistantContextChannelId({
            sourceChannelId: resolvedSourceChannelId,
            threadId,
          }),
      });
    },
    refreshAssistantThreadContext: async ({
      threadId,
      channelId,
      threadTs,
      sourceChannelId,
    }) => {
      await refreshAssistantThreadContextImpl({
        channelId,
        threadTs,
        sourceChannelId,
        getSlackAdapter: options.getSlackAdapter,
        onContextChannelResolved: (resolvedSourceChannelId) =>
          persistAssistantContextChannelId({
            sourceChannelId: resolvedSourceChannelId,
            threadId,
          }),
      });
    },
  });
}
