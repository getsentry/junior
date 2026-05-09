import type { Message, Thread } from "chat";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { toOptionalString } from "@/chat/coerce";
import { setSpanAttributes } from "@/chat/logging";
import { getThreadTs } from "@/chat/runtime/thread-context";
import { getSlackMessageTs } from "@/chat/slack/message";
import {
  coerceThreadArtifactsState,
  type ThreadArtifactsState,
} from "@/chat/state/artifacts";
import {
  buildConversationContext,
  isHumanConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  countPotentialImageAttachments,
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/services/vision-context";
import { getChannelConfigurationService } from "@/chat/runtime/thread-state";
import type { ChannelConfigurationService } from "@/chat/configuration/types";

const BACKFILL_MESSAGE_LIMIT = 80;

export interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  conversation: ThreadConversationState;
  conversationContext?: string;
  routingContext?: string;
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  userMessageId?: string;
}

export interface PrepareTurnStateDeps {
  compactConversationIfNeeded: (
    conversation: ThreadConversationState,
    context: {
      threadId?: string;
      channelId?: string;
      requesterId?: string;
      runId?: string;
    },
  ) => Promise<void>;
  hydrateConversationVisionContext: (
    conversation: ThreadConversationState,
    context: {
      threadId?: string;
      channelId?: string;
      requesterId?: string;
      runId?: string;
      threadTs?: string;
    },
  ) => Promise<void>;
}

function hasPendingImageHydration(
  conversation: ThreadConversationState,
): boolean {
  return conversation.messages.some(
    (message) =>
      isHumanConversationMessage(message) && !message.meta?.imagesHydrated,
  );
}

function createConversationMessageFromSdkMessage(
  entry: Message,
): ConversationMessage | null {
  const rawText = normalizeConversationText(entry.text);
  if (!rawText) {
    return null;
  }

  return {
    id: entry.id,
    role: entry.author.isMe ? "assistant" : "user",
    text: rawText,
    createdAtMs: entry.metadata.dateSent.getTime(),
    author: {
      userId: entry.author.userId,
      userName: entry.author.userName,
      fullName: entry.author.fullName,
      isBot:
        typeof entry.author.isBot === "boolean"
          ? entry.author.isBot
          : undefined,
    },
    meta: {
      slackTs: getSlackMessageTs(entry),
    },
  };
}

async function seedConversationBackfill(
  thread: Thread,
  conversation: ThreadConversationState,
  currentTurn: {
    messageId: string;
    messageCreatedAtMs: number;
  },
): Promise<void> {
  if (conversation.backfill.completedAtMs) {
    return;
  }
  if (conversation.messages.length > 0 || conversation.compactions.length > 0) {
    conversation.backfill = {
      completedAtMs: Date.now(),
      source: "recent_messages",
    };
    updateConversationStats(conversation);
    return;
  }

  const seeded: ConversationMessage[] = [];
  let source: "recent_messages" | "thread_fetch" = "recent_messages";

  try {
    const fetchedNewestFirst: Message[] = [];
    for await (const entry of thread.messages) {
      fetchedNewestFirst.push(entry);
      if (fetchedNewestFirst.length >= BACKFILL_MESSAGE_LIMIT) {
        break;
      }
    }
    fetchedNewestFirst.reverse();
    for (const entry of fetchedNewestFirst) {
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    if (seeded.length > 0) {
      source = "thread_fetch";
    }
  } catch {}

  if (seeded.length === 0) {
    try {
      await thread.refresh();
    } catch {}

    const fromRecent = thread.recentMessages.slice(-BACKFILL_MESSAGE_LIMIT);
    for (const entry of fromRecent) {
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    source = "recent_messages";
  }

  for (const message of seeded) {
    if (
      message.id !== currentTurn.messageId &&
      message.createdAtMs > currentTurn.messageCreatedAtMs
    ) {
      continue;
    }
    if (
      message.id !== currentTurn.messageId &&
      message.createdAtMs === currentTurn.messageCreatedAtMs &&
      message.id > currentTurn.messageId
    ) {
      continue;
    }
    upsertConversationMessage(conversation, message);
  }

  conversation.backfill = {
    completedAtMs: Date.now(),
    source,
  };
  updateConversationStats(conversation);
}

/** Build the turn-state preparer from injected conversation services. */
export function createPrepareTurnState(deps: PrepareTurnStateDeps) {
  return async function prepareTurnState(args: {
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
      ? toOptionalString(
          (existingState as Record<string, unknown>).app_sandbox_id,
        )
      : undefined;
    const existingSandboxDependencyProfileHash = existingState
      ? toOptionalString(
          (existingState as Record<string, unknown>)
            .app_sandbox_dependency_profile_hash,
        )
      : undefined;
    const artifacts = coerceThreadArtifactsState(existingState);
    const conversation = coerceThreadConversationState(existingState);
    const channelConfiguration = getChannelConfigurationService(args.thread);
    const configuration = await channelConfiguration.resolveValues();

    await seedConversationBackfill(args.thread, conversation, {
      messageId: args.message.id,
      messageCreatedAtMs: args.message.metadata.dateSent.getTime(),
    });
    const messageHasPotentialImageAttachment = hasPotentialImageAttachment(
      args.message.attachments,
    );
    const imageAttachmentCount = messageHasPotentialImageAttachment
      ? countPotentialImageAttachments(args.message.attachments)
      : 0;

    const normalizedUserText =
      normalizeConversationText(args.userText) || "[non-text message]";
    const slackTs = getSlackMessageTs(args.message);
    const incomingUserMessage: ConversationMessage = {
      id: args.message.id,
      role: "user",
      text: normalizedUserText,
      createdAtMs: args.message.metadata.dateSent.getTime(),
      author: {
        userId: args.message.author.userId,
        userName: args.message.author.userName,
        fullName: args.message.author.fullName,
        isBot:
          typeof args.message.author.isBot === "boolean"
            ? args.message.author.isBot
            : undefined,
      },
      meta: {
        attachmentCount: args.message.attachments.length,
        explicitMention: args.explicitMention,
        imageAttachmentCount:
          imageAttachmentCount > 0 ? imageAttachmentCount : undefined,
        slackTs,
        imagesHydrated: !messageHasPotentialImageAttachment,
      },
    };

    const userMessageId = upsertConversationMessage(
      conversation,
      incomingUserMessage,
    );

    const shouldHydrateVisionContext =
      !conversation.vision.backfillCompletedAtMs ||
      messageHasPotentialImageAttachment ||
      hasPendingImageHydration(conversation);

    if (isVisionEnabled() && shouldHydrateVisionContext) {
      await deps.hydrateConversationVisionContext(conversation, {
        threadId: args.context.threadId,
        channelId: args.context.channelId,
        requesterId: args.context.requesterId,
        runId: args.context.runId,
        threadTs: getThreadTs(args.context.threadId),
      });
    }

    await deps.compactConversationIfNeeded(conversation, {
      threadId: args.context.threadId,
      channelId: args.context.channelId,
      requesterId: args.context.requesterId,
      runId: args.context.runId,
    });

    const conversationContext = buildConversationContext(conversation);
    const routingContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });

    setSpanAttributes({
      "app.backfill_source": conversation.backfill.source ?? "none",
      "app.context_tokens_estimated": conversation.stats.estimatedContextTokens,
    });

    return {
      artifacts,
      configuration,
      channelConfiguration,
      conversation,
      sandboxId: existingSandboxId,
      sandboxDependencyProfileHash: existingSandboxDependencyProfileHash,
      conversationContext,
      routingContext,
      userMessageId,
    };
  };
}
