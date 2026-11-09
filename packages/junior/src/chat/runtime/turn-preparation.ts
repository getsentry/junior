/**
 * Turn state preparation.
 *
 * This module turns durable chat thread state plus the current Slack message
 * into the state needed before agent execution. It owns conversation backfill,
 * memory/context rendering, vision hydration, and configuration; it should not execute the agent or post replies.
 */
import type { Message, Thread } from "chat";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { setSpanAttributes } from "@/chat/logging";
import { getThreadTs } from "@/chat/runtime/thread-context";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  buildConversationContext,
  estimateConversationMessagesTokens,
  isHumanConversationMessage,
  normalizeConversationText,
  trimConversationMessages,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import {
  hasPotentialImageAttachment,
  isVisionEnabled,
} from "@/chat/slack/vision-context";
import {
  loadConversationVisionCache,
  persistConversationVisionCache,
} from "@/chat/slack/vision-cache";
import {
  getLocationConfigurationService,
  getPersistedSandboxState,
  getPersistedThreadState,
} from "@/chat/runtime/thread-state";
import {
  hydrateConversationMessages,
  persistConversationMessages,
  persistConversationMessageWindow,
} from "@/chat/conversations/messages";
import { loadThreadContextTrimFloor } from "@/chat/conversations/thread-context";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { parseContent } from "@/chat/slack/message/content";
import type {
  PrepareTurnStateInput,
  TurnContext,
} from "@/chat/runtime/turn-input";
import { toConversationMessage } from "@/chat/runtime/conversation-message";

const BACKFILL_MESSAGE_LIMIT = 80;

export interface PreparedTurnState {
  configuration?: Record<string, unknown>;
  locationConfiguration?: LocationConfigurationService;
  conversation: ThreadConversationState;
  /** Latest thread Messages for reply decisions. A Turn prompt builds its own. */
  conversationContext?: string;
  sandboxRef?: SandboxRef;
  userMessageAlreadyReplied?: boolean;
  userMessageId?: string;
}

export interface PrepareTurnStateDeps {
  hydrateConversationVisionContext: (
    conversation: ThreadConversationState,
    context: TurnContext & { threadTs?: string },
  ) => Promise<void>;
  resolveBackfillMessageActors: (
    messages: Message[],
    destination: PrepareTurnStateInput["destination"],
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
 * trimming can reason over a thread even when no prior app state exists.
 */
async function seedConversationBackfill(
  thread: Thread,
  conversation: ThreadConversationState,
  currentTurn: {
    messageId: string;
    messageCreatedAtMs: number;
  },
  resolveMessageActors: (messages: Message[]) => Promise<void>,
): Promise<"recent_messages" | "thread_fetch"> {
  if (
    conversation.messages.length > 0 ||
    conversation.historyFromSeq !== undefined
  ) {
    return "recent_messages";
  }

  const seeded: ConversationMessage[] = [];
  let source: "recent_messages" | "thread_fetch" = "recent_messages";

  let fetchedNewestFirst: Message[] | undefined;
  try {
    const fetched: Message[] = [];
    for await (const entry of thread.messages) {
      fetched.push(entry);
      if (fetched.length >= BACKFILL_MESSAGE_LIMIT) {
        break;
      }
    }
    fetchedNewestFirst = fetched.reverse();
  } catch {}

  if (fetchedNewestFirst) {
    await resolveMessageActors(fetchedNewestFirst);
    for (const entry of fetchedNewestFirst) {
      const text = getBackfillText(entry);
      if (text) {
        seeded.push(toConversationMessage({ entry, text }));
      }
    }
    if (seeded.length > 0) {
      source = "thread_fetch";
    }
  }

  if (seeded.length === 0) {
    try {
      await thread.refresh();
    } catch {}

    const fromRecent = thread.recentMessages.slice(-BACKFILL_MESSAGE_LIMIT);
    await resolveMessageActors(fromRecent);
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
    const conversationId =
      args.context.conversationId ??
      args.context.threadId ??
      args.context.runId;
    const existingState = conversationId
      ? await getPersistedThreadState(conversationId)
      : await args.thread.state;
    const sandboxRef = getPersistedSandboxState(existingState ?? {});
    const conversation = coerceThreadConversationState(existingState);
    if (conversationId && isVisionEnabled()) {
      conversation.vision = await loadConversationVisionCache(conversationId);
    }
    await hydrateConversationMessages({ conversation, conversationId });
    const locationConfiguration =
      args.locationConfiguration ??
      getLocationConfigurationService(args.destination);
    const configuration = await locationConfiguration.resolveValues();

    const backfillSource = args.skipBackfill
      ? undefined
      : await seedConversationBackfill(
          args.thread,
          conversation,
          {
            messageId: args.message.id,
            messageCreatedAtMs: args.message.metadata.dateSent.getTime(),
          },
          (messages) =>
            deps.resolveBackfillMessageActors(messages, args.destination),
        );
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
        conversationId,
        threadId: args.context.threadId,
        channelId: args.context.channelId,
        actorId: args.context.actorId,
        runId: args.context.runId,
        threadTs: getThreadTs(args.context.threadId),
      });
      if (conversationId) {
        await persistConversationVisionCache(
          conversationId,
          conversation.vision,
        );
      }
    }

    // Record the visible transcript after vision hydration (so the current
    // turn's messages capture their image-context meta) but before trimming
    // drops older Messages, so every live message reaches SQL at least once.
    await persistConversationMessages({ conversation, conversationId });
    if (conversationId) {
      // Reload so every Message has its seq. The Turn saves the highest seq
      // as its thread context cursor.
      await hydrateConversationMessages({ conversation, conversationId });
    }

    if (
      (await trimConversationMessages(conversation, async () =>
        conversationId
          ? await loadThreadContextTrimFloor(conversationId)
          : undefined,
      )) &&
      conversationId &&
      conversation.historyFromSeq !== undefined
    ) {
      await persistConversationMessageWindow({
        conversationId,
        historyFromSeq: conversation.historyFromSeq,
      });
    }

    const conversationContext = buildConversationContext(conversation, {
      excludeMessageIds: [userMessageId],
    }).text;

    setSpanAttributes({
      "app.backfill_source": backfillSource ?? "none",
      "app.context_tokens_estimated":
        estimateConversationMessagesTokens(conversation),
    });

    return {
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
