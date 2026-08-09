/**
 * Turn state preparation.
 *
 * This module turns durable chat thread state plus the current Slack message
 * into the state needed before agent execution. It owns conversation backfill,
 * memory/context rendering, vision hydration, configuration, and artifact
 * snapshots; it should not execute the agent or post replies.
 */
import type { Message, Thread } from "chat";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { setSpanAttributes } from "@/chat/logging";
import { getThreadTs } from "@/chat/runtime/thread-context";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  buildConversationContext,
  estimateConversationContextTokens,
  isHumanConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/slack/vision-context";
import {
  getLocationConfigurationService,
  loadThreadRuntimeState,
} from "@/chat/runtime/thread-state";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import { persistConversationMessageSummaries } from "@/chat/conversations/message-summaries";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { parseContent } from "@/chat/slack/message/content";
import type {
  PrepareTurnStateInput,
  TurnContext,
} from "@/chat/runtime/turn-input";
import { toConversationMessage } from "@/chat/runtime/conversation-message";

const BACKFILL_MESSAGE_LIMIT = 80;

export interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  locationConfiguration?: LocationConfigurationService;
  conversation: ThreadConversationState;
  conversationContext?: string;
  sandboxRef?: SandboxRef;
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
  const text = normalizeConversationText(parseContent(entry).text);
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
): Promise<"recent_messages" | "thread_fetch"> {
  if (conversation.messages.length > 0 || conversation.compactions.length > 0) {
    return "recent_messages";
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

  return source;
}

/** Build the turn-state preparer from injected conversation services. */
export function createPrepareTurnState(deps: PrepareTurnStateDeps) {
  return async function prepareTurnState(
    args: PrepareTurnStateInput,
  ): Promise<PreparedTurnState> {
    const conversationId = args.context.threadId ?? args.context.runId;
    if (!conversationId) {
      throw new Error("thread id is required to load runtime scratch");
    }
    const { artifacts, conversation, sandboxRef } =
      await loadThreadRuntimeState(conversationId);
    await hydrateConversationMessages({ conversation, conversationId });
    const locationConfiguration =
      args.locationConfiguration ??
      getLocationConfigurationService(args.destination);
    const configuration = await locationConfiguration.resolveValues();

    const backfillSource = args.skipBackfill
      ? undefined
      : await seedConversationBackfill(args.thread, conversation, {
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
        actorId: args.context.actorId,
        runId: args.context.runId,
        threadTs: getThreadTs(args.context.threadId),
      });
    }

    // Record the visible transcript after vision hydration (so the current
    // turn's messages capture their image-context meta) but before compaction
    // trims the working set, so every live message reaches SQL at least once.
    await persistConversationMessages({ conversation, conversationId });

    await deps.compactConversationIfNeeded(conversation, {
      threadId: args.context.threadId,
      channelId: args.context.channelId,
      actorId: args.context.actorId,
      runId: args.context.runId,
    });
    if (conversationId) {
      await persistConversationMessageSummaries({
        conversation,
        conversationId,
      });
    }

    const conversationContext = buildConversationContext(conversation, {
      excludeMessageId: userMessageId,
    });

    setSpanAttributes({
      "app.backfill_source": backfillSource ?? "none",
      "app.context_tokens_estimated":
        estimateConversationContextTokens(conversation),
    });

    return {
      artifacts,
      configuration,
      locationConfiguration,
      conversation,
      sandboxRef,
      conversationContext,
      userMessageAlreadyReplied,
      userMessageId,
    };
  };
}
