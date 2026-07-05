/**
 * Turn state preparation.
 *
 * This module turns durable chat thread state plus the current Slack message
 * into the state needed before agent execution. It owns conversation backfill,
 * memory/context rendering, vision hydration, configuration, and artifact
 * snapshots; it should not execute the agent or post replies.
 */
import type { Message, Thread } from "chat";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { toOptionalString } from "@/chat/coerce";
import { setSpanAttributes } from "@/chat/logging";
import { getThreadTs } from "@/chat/runtime/thread-context";
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
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/slack/vision-context";
import { getChannelConfigurationService } from "@/chat/runtime/thread-state";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { appendSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";
import type {
  PrepareTurnStateInput,
  TurnContext,
} from "@/chat/runtime/turn-input";
import { toConversationMessage } from "@/chat/runtime/conversation-message";

const BACKFILL_MESSAGE_LIMIT = 80;

export interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  conversation: ThreadConversationState;
  conversationContext?: string;
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  userMessageAlreadyReplied?: boolean;
  userMessageId?: string;
}

export interface PrepareTurnStateDeps {
  compactConversationIfNeeded: (
    conversation: ThreadConversationState,
    context: TurnContext,
  ) => Promise<void>;
  hydrateConversationVisionContext: (
    conversation: ThreadConversationState,
    context: TurnContext & { threadTs?: string },
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

function getBackfillText(entry: Message): string | undefined {
  const text = normalizeConversationText(
    appendSlackLegacyAttachmentText(entry.text, entry.raw),
  );
  return text || undefined;
}

/**
 * Seed durable conversation memory before the current turn so routing and
 * compaction can reason over a thread even when no prior app state exists.
 */
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
      const text = getBackfillText(entry);
      if (text) {
        seeded.push(toConversationMessage({ entry, text }));
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
      const text = getBackfillText(entry);
      if (text) {
        seeded.push(toConversationMessage({ entry, text }));
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
  return async function prepareTurnState(
    args: PrepareTurnStateInput,
  ): Promise<PreparedTurnState> {
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
    for (const queued of args.queuedMessages ?? []) {
      const queuedMessage = toConversationMessage({
        entry: queued.message,
        explicitMention: queued.explicitMention,
        text: queued.userText,
      });
      upsertConversationMessage(conversation, queuedMessage);
    }

    const incomingUserMessage = toConversationMessage({
      entry: args.message,
      explicitMention: args.explicitMention,
      text: args.text.userText,
    });
    const userMessageAlreadyReplied = conversation.messages.some(
      (entry) => entry.id === incomingUserMessage.id && entry.meta?.replied,
    );

    const userMessageId = upsertConversationMessage(
      conversation,
      incomingUserMessage,
    );

    const messageHasPotentialImageAttachment =
      hasPotentialImageAttachment(args.message.attachments) ||
      (args.queuedMessages ?? []).some((queued) =>
        hasPotentialImageAttachment(queued.message.attachments),
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

    const conversationContext = buildConversationContext(conversation, {
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
      userMessageAlreadyReplied,
      userMessageId,
    };
  };
}
