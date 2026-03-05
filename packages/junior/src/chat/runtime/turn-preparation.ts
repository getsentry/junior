import type { Message, Thread } from "chat";
import { coerceThreadConversationState } from "@/chat/conversation-state";
import type { ConversationMessage, ThreadConversationState } from "@/chat/conversation-state";
import { setSpanAttributes, toOptionalString } from "@/chat/observability";
import { getThreadTs } from "@/chat/runtime/thread-context";
import { coerceThreadArtifactsState, type ThreadArtifactsState } from "@/chat/slack-actions/types";
import { compactConversationIfNeeded, buildConversationContext, normalizeConversationText, seedConversationBackfill, upsertConversationMessage } from "@/chat/services/conversation-memory";
import { hydrateConversationVisionContext } from "@/chat/services/vision-context";
import { getChannelConfigurationService } from "@/chat/runtime/thread-state";
import type { ChannelConfigurationService } from "@/chat/configuration/types";

export interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  conversation: ThreadConversationState;
  conversationContext?: string;
  routingContext?: string;
  sandboxId?: string;
  userMessageId?: string;
}

export async function prepareTurnState(args: {
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
}): Promise<PreparedTurnState> {
  const existingState = await args.thread.state;
  const existingSandboxId = existingState
    ? toOptionalString((existingState as Record<string, unknown>).app_sandbox_id)
    : undefined;
  const artifacts = coerceThreadArtifactsState(existingState);
  const conversation = coerceThreadConversationState(existingState);
  const channelConfiguration = getChannelConfigurationService(args.thread);
  const configuration = await channelConfiguration.resolveValues();

  await seedConversationBackfill(args.thread, conversation, {
    messageId: args.message.id,
    messageCreatedAtMs: args.message.metadata.dateSent.getTime()
  });
  const messageHasPotentialImageAttachment = args.message.attachments.some((attachment) => {
    if (attachment.type === "image") {
      return true;
    }
    const mimeType = attachment.mimeType ?? "";
    return attachment.type === "file" && mimeType.startsWith("image/");
  });

  const normalizedUserText = normalizeConversationText(args.userText) || "[non-text message]";
  const incomingUserMessage: ConversationMessage = {
    id: args.message.id,
    role: "user",
    text: normalizedUserText,
    createdAtMs: args.message.metadata.dateSent.getTime(),
    author: {
      userId: args.message.author.userId,
      userName: args.message.author.userName,
      fullName: args.message.author.fullName,
      isBot: typeof args.message.author.isBot === "boolean" ? args.message.author.isBot : undefined
    },
    meta: {
      explicitMention: args.explicitMention,
      slackTs: args.message.id,
      imagesHydrated: !messageHasPotentialImageAttachment
    }
  };

  const userMessageId = upsertConversationMessage(conversation, incomingUserMessage);

  if (messageHasPotentialImageAttachment || !conversation.vision.backfillCompletedAtMs) {
    await hydrateConversationVisionContext(conversation, {
      threadId: args.context.threadId,
      channelId: args.context.channelId,
      requesterId: args.context.requesterId,
      runId: args.context.runId,
      threadTs: getThreadTs(args.context.threadId)
    });
  }

  await compactConversationIfNeeded(conversation, {
    threadId: args.context.threadId,
    channelId: args.context.channelId,
    requesterId: args.context.requesterId,
    runId: args.context.runId
  });

  const conversationContext = buildConversationContext(conversation);
  const routingContext = buildConversationContext(conversation, {
    excludeMessageId: userMessageId
  });

  setSpanAttributes({
    "app.backfill_source": conversation.backfill.source ?? "none",
    "app.context_tokens_estimated": conversation.stats.estimatedContextTokens
  });

  return {
    artifacts,
    configuration,
    channelConfiguration,
    conversation,
    sandboxId: existingSandboxId,
    conversationContext,
    routingContext,
    userMessageId
  };
}
