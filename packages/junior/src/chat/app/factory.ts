import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message } from "chat";
import {
  createSlackTurnRuntime,
  type AssistantLifecycleEvent,
} from "@/chat/runtime/slack-runtime";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { coerceThreadConversationState } from "@/chat/state/conversation";
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
  getLocationConfigurationService,
  persistThreadState,
} from "@/chat/runtime/thread-state";
import {
  createPrepareTurnState,
  type PreparedTurnState,
} from "@/chat/runtime/turn-preparation";
import type { TurnMessageText } from "@/chat/runtime/turn-input";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { toConversationMessage } from "@/chat/runtime/conversation-message";
import {
  markConversationMessage,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import type { SubscribedReplyDecision } from "@/chat/services/subscribed-reply-policy";
import { botConfig } from "@/chat/config";
import { standardModelId } from "@/chat/model-profile";
import { cancelSubscriptions as cancelEventSubscriptions } from "@/chat/resource-events/store";
import { recordSubscribedReplyRoute } from "@/chat/conversations/projection";
import { createSlackDispatchTurnRunner } from "@/chat/slack/dispatch-turn";
import {
  ensureSlackMessageActorIdentity,
  getMessageActorIdentity,
} from "@/chat/services/message-actor-identity";

export interface CreateSlackRuntimeOptions {
  getSlackAdapter: () => SlackAdapter;
  now?: () => number;
  services?: JuniorRuntimeServiceOverrides;
}

function clearSkippedTurnIfActive(
  conversation: PreparedTurnState["conversation"],
  messageId: string,
): void {
  if (
    conversation.processing.activeTurnId === buildDeterministicTurnId(messageId)
  ) {
    conversation.processing.activeTurnId = undefined;
  }
}

function upsertSkippedConversationMessage(
  conversation: PreparedTurnState["conversation"],
  args: {
    decision: SubscribedReplyDecision;
    message: Message;
    text: TurnMessageText;
  },
): void {
  const conversationMessage = toConversationMessage({
    entry: args.message,
    explicitMention: Boolean(args.message.isMention),
    text: args.text.userText,
  });
  upsertConversationMessage(conversation, {
    ...conversationMessage,
    meta: {
      ...conversationMessage.meta,
      replied: false,
      skippedReason: args.decision.reason,
    },
  });
}

export function createSlackRuntime(options: CreateSlackRuntimeOptions) {
  const services = createJuniorRuntimeServices(options.services);
  const prepareTurnState = createPrepareTurnState({
    compactConversationIfNeeded:
      services.conversationMemory.compactConversationIfNeeded,
    hydrateConversationVisionContext:
      services.visionContext.hydrateConversationVisionContext,
    resolveBackfillMessageActors: async (messages, destination) => {
      if (destination.platform !== "slack") {
        throw new Error("Slack turn backfill requires a Slack destination");
      }
      await Promise.all(
        messages
          .filter((message) => {
            const actor = getMessageActorIdentity(message);
            return (
              !message.author.isMe &&
              Boolean(actor?.userId) &&
              !actor?.fullName &&
              !actor?.userName
            );
          })
          .map((message) =>
            ensureSlackMessageActorIdentity(
              message,
              destination.teamId,
              services.replyExecutor.lookupSlackUser,
            ),
          ),
      );
    },
  });
  const replyToThread = createReplyToThread({
    getSlackAdapter: options.getSlackAdapter,
    prepareTurnState,
    resolveUserAttachments: services.visionContext.resolveUserAttachments,
    services: services.replyExecutor,
  });

  const runtime = createSlackTurnRuntime<
    PreparedTurnState,
    AssistantLifecycleEvent
  >({
    assistantUserName: botConfig.userName,
    cancelEventSubscriptions,
    modelId: standardModelId(botConfig),
    now: options.now ?? (() => Date.now()),
    getThreadId,
    getChannelId,
    getRunId,
    stripLeadingBotMention: (text, stripOptions) =>
      stripLeadingBotMention(text, {
        ...stripOptions,
        botUserId: options.getSlackAdapter().botUserId,
      }),
    withSpan,
    logWarn,
    logException,
    failConversationTurn: (input) =>
      services.replyExecutor.turnLifecycle.fail(input),
    prepareTurnState,
    persistPreparedState: async ({ thread, preparedState }) => {
      await persistThreadState(thread, {
        conversation: preparedState.conversation,
      });
    },
    getPreparedConversationContext: (preparedState) =>
      preparedState.conversationContext,
    decideSubscribedReply: async (args) => {
      const decision = await services.subscribedReplyPolicy(args);
      if (
        decision.costUsd !== undefined &&
        args.context.threadId &&
        args.context.runId
      ) {
        await recordSubscribedReplyRoute({
          conversationId: args.context.threadId,
          costUsd: decision.costUsd,
          reason: decision.reason,
          runId: args.context.runId,
          shouldReply: decision.shouldReply,
          ...(decision.shouldUnsubscribe !== undefined
            ? { shouldUnsubscribe: decision.shouldUnsubscribe }
            : {}),
        });
      }
      return decision;
    },
    recordSkippedSteeringMessage: async ({
      thread,
      message,
      decision,
      text,
    }) => {
      const conversation = coerceThreadConversationState(await thread.state);
      upsertSkippedConversationMessage(conversation, {
        decision,
        message,
        text,
      });
      await persistThreadState(thread, {
        conversation,
      });
    },
    recordSkippedSubscribedTurn: async ({
      thread,
      message,
      decision,
      completedAtMs,
      text,
    }) => {
      const conversation = coerceThreadConversationState(await thread.state);
      upsertSkippedConversationMessage(conversation, {
        decision,
        message,
        text,
      });
      clearSkippedTurnIfActive(conversation, message.id);
      conversation.processing.lastCompletedAtMs = completedAtMs;
      await persistThreadState(thread, {
        conversation,
      });
    },
    onSubscribedMessageSkipped: async ({
      thread,
      message,
      preparedState,
      decision,
      completedAtMs,
    }) => {
      markConversationMessage(
        preparedState.conversation,
        preparedState.userMessageId,
        {
          replied: false,
          skippedReason: decision.reason,
        },
      );
      clearSkippedTurnIfActive(preparedState.conversation, message.id);
      preparedState.conversation.processing.lastCompletedAtMs = completedAtMs;
      await persistThreadState(thread, {
        conversation: preparedState.conversation,
      });
    },
    replyToThread,
    initializeAssistantThread: async ({
      channelId,
      threadTs,
      sourceChannelId,
    }) => {
      await initializeAssistantThreadImpl({
        channelId,
        threadTs,
        sourceChannelId,
        getSlackAdapter: options.getSlackAdapter,
      });
    },
    refreshAssistantThreadContext: async ({
      channelId,
      threadTs,
      sourceChannelId,
    }) => {
      await refreshAssistantThreadContextImpl({
        channelId,
        threadTs,
        sourceChannelId,
        getSlackAdapter: options.getSlackAdapter,
      });
    },
  });
  return {
    ...runtime,
    runDispatchTurn: createSlackDispatchTurnRunner({
      getLocationConfiguration: getLocationConfigurationService,
      getSlackAdapter: options.getSlackAdapter,
      replyToThread,
    }),
  };
}
