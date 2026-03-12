import { Chat } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackAdapter } from "@chat-adapter/slack";
import "@/chat/chat-background-patch";
import {
  createAppSlackRuntime,
  type AppRuntimeAssistantLifecycleEvent,
} from "@/chat/app-runtime";
import { registerBotHandlers } from "@/chat/bootstrap/register-handlers";
import {
  botConfig,
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import {
  logException,
  logWarn,
  resolveErrorReference,
  withSpan,
} from "@/chat/observability";
import { getStateAdapter } from "@/chat/state";
import { initializeAssistantThread as initializeAssistantThreadImpl } from "@/chat/runtime/assistant-lifecycle";
import { resetBotDepsForTests, setBotDepsForTests } from "@/chat/runtime/deps";
import { createReplyToThread } from "@/chat/runtime/reply-executor";
import { createNormalizingStream } from "@/chat/runtime/streaming";
import { shouldReplyInSubscribedThread } from "@/chat/runtime/subscribed-routing";
import {
  getChannelId,
  getThreadId,
  getRunId,
  stripLeadingBotMention,
} from "@/chat/runtime/thread-context";
import { persistThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/conversation-state";
import {
  prepareTurnState,
  type PreparedTurnState,
} from "@/chat/runtime/turn-preparation";
import {
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";

const createdBot = new Chat<{ slack: SlackAdapter }>({
  userName: botConfig.userName,
  adapters: {
    slack: (() => {
      const signingSecret = getSlackSigningSecret();
      const botToken = getSlackBotToken();
      const clientId = getSlackClientId();
      const clientSecret = getSlackClientSecret();

      if (!signingSecret) {
        throw new Error("SLACK_SIGNING_SECRET is required");
      }

      return createSlackAdapter({
        signingSecret,
        ...(botToken ? { botToken } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
    })(),
  },
  state: getStateAdapter(),
});

const registerSingleton = (
  createdBot as unknown as { registerSingleton?: () => unknown }
).registerSingleton;
if (typeof registerSingleton === "function") {
  registerSingleton.call(createdBot);
}

export const bot = createdBot;

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack");
}

const replyToThread = createReplyToThread({
  getSlackAdapter,
  prepareTurnState,
});

export const appSlackRuntime = createAppSlackRuntime<
  PreparedTurnState,
  AppRuntimeAssistantLifecycleEvent
>({
  assistantUserName: botConfig.userName,
  modelId: botConfig.modelId,
  now: () => Date.now(),
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
  shouldReplyInSubscribedThread,
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
        slackTs: message.id,
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
      getSlackAdapter,
    });
  },
});

registerBotHandlers({
  bot,
  appSlackRuntime,
});

export { createNormalizingStream, resetBotDepsForTests, setBotDepsForTests };
