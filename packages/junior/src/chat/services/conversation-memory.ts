import { messageCardRef, type MessageCard } from "@/chat/conversations/cards";
import { botConfig } from "@/chat/config";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { setSpanAttributes } from "@/chat/logging";
import {
  calculateContextCompactionTargetTokens,
  getConversationContextCompactionTriggerTokens,
} from "@/chat/services/context-budget";
import { estimateTextTokens } from "@/chat/services/token-estimate";

import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import { escapeTagTextAndQuotes } from "@sentry/junior-plugin-api";
import { isTurnReply } from "@/chat/state/turn-id";

const CONTEXT_MIN_LIVE_MESSAGES = 12;
const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;

/** Normalize message boundaries without changing transcript formatting. */
export function normalizeConversationText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function buildImageContextSuffix(
  message: ConversationMessage,
  conversation: ThreadConversationState | undefined,
): string {
  const byFileId = conversation?.vision.byFileId;
  const imageFileIds = message.meta?.imageFileIds ?? [];
  if (!byFileId || imageFileIds.length === 0) {
    return "";
  }

  const summaries = imageFileIds
    .map((fileId) => byFileId[fileId]?.summary?.trim())
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length === 0) {
    return "";
  }

  return ` [image context: ${escapeTagTextAndQuotes(summaries.join(" | "))}]`;
}

/**
 * Render one Message as a single escaped transcript line. `text` replaces the
 * Message text, such as when a caller cuts it to a budget.
 */
export function renderConversationMessageLine(
  message: ConversationMessage,
  conversation?: ThreadConversationState,
  text: string = message.text,
): string {
  const displayName = escapeTagTextAndQuotes(
    conversationAuthorDisplayName(message),
  );
  const lineText = escapeTagTextAndQuotes(text.replace(/\s+/g, " "));

  const markers: string[] = [];
  if (message.meta?.replied === false) {
    markers.push(
      escapeTagTextAndQuotes(
        `assistant skipped: ${message.meta?.skippedReason ?? "no-reply route"}`,
      ),
    );
  }
  if (message.meta?.explicitMention) {
    markers.push("explicit mention");
  }

  const markerSuffix = markers.length > 0 ? ` (${markers.join("; ")})` : "";
  const imageContext = buildImageContextSuffix(message, conversation);
  return `[${message.role}] ${displayName}: ${lineText}${imageContext}${markerSuffix}`;
}

/** Return the name to show for a Message author, never a raw Slack id. */
export function conversationAuthorDisplayName(
  message: ConversationMessage,
): string {
  const author = message.author;
  const fullName = authorDisplayField(author?.fullName, author?.userId);
  const userName = authorDisplayField(author?.userName, author?.userId);
  return (
    fullName ??
    userName ??
    (message.role === "assistant" ? botConfig.userName : message.role)
  );
}

function authorDisplayField(
  value: string | undefined,
  userId: string | undefined,
): string | undefined {
  if (!value || value === userId || SLACK_USER_ID_DISPLAY_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

/** Estimate the visible Message working set that trimming bounds. */
export function estimateConversationMessagesTokens(
  conversation: ThreadConversationState,
): number {
  return estimateTextTokens(
    conversation.messages
      .map((message) => renderConversationMessageLine(message, conversation))
      .join("\n"),
  );
}

export function upsertConversationMessage(
  conversation: ThreadConversationState,
  message: ConversationMessage,
): string {
  const existingIndex = conversation.messages.findIndex(
    (entry) => entry.id === message.id,
  );
  if (existingIndex >= 0) {
    conversation.messages[existingIndex] = {
      ...conversation.messages[existingIndex],
      ...message,
      meta: {
        ...conversation.messages[existingIndex]?.meta,
        ...message.meta,
      },
    };
    return message.id;
  }

  conversation.messages.push(message);
  return message.id;
}

/** Record one assistant message after its destination accepts it. */
export function recordDeliveredAssistantMessage(args: {
  cards?: MessageCard[] | undefined;
  conversation: ThreadConversationState;
  sessionId: string;
  source?: "slack" | "web" | undefined;
  text: string;
  userMessageId?: string | undefined;
}): string {
  const ordinal =
    args.conversation.messages.filter((message) =>
      isTurnReply(message, args.sessionId),
    ).length + 1;
  const messageId = `${args.sessionId}:assistant:${ordinal}`;
  markConversationMessage(args.conversation, args.userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  const objectCards = args.cards?.map(messageCardRef);
  upsertConversationMessage(args.conversation, {
    id: messageId,
    role: "assistant",
    text: normalizeConversationText(args.text),
    createdAtMs: Date.now(),
    author: {
      userName: botConfig.userName,
      isBot: true,
    },
    meta: {
      ...(objectCards?.length ? { objectCards } : undefined),
      replied: true,
      ...(args.source ? { source: args.source } : undefined),
      turnId: args.sessionId,
    },
  });
  return messageId;
}

/** Return whether a turn already has a destination-accepted assistant reply. */
export function turnHasReply(
  conversation: ThreadConversationState,
  turnId: string,
): boolean {
  return conversation.messages.some((message) => isTurnReply(message, turnId));
}

export function markConversationMessage(
  conversation: ThreadConversationState,
  messageId: string | undefined,
  patch: Partial<NonNullable<ConversationMessage["meta"]>>,
): void {
  if (!messageId) return;

  const messageIndex = conversation.messages.findIndex(
    (entry) => entry.id === messageId,
  );
  if (messageIndex < 0) return;

  const current = conversation.messages[messageIndex];
  if (!current) return;
  conversation.messages[messageIndex] = {
    ...current,
    meta: {
      ...(current.meta ?? {}),
      ...patch,
    },
  };
}

/** Return the highest saved Message seq, the thread context cursor of a Turn. */
export function latestConversationMessageSeq(
  conversation: Pick<ThreadConversationState, "messages">,
): number | undefined {
  let latest: number | undefined;
  for (const message of conversation.messages) {
    if (message.seq !== undefined && (latest ?? -1) < message.seq) {
      latest = message.seq;
    }
  }
  return latest;
}

/** Return the earliest human-authored message known for a thread. */
export function getThreadTitleSourceMessage(
  conversation: ThreadConversationState,
): ConversationMessage | undefined {
  let firstMessage: ConversationMessage | undefined;

  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) {
      continue;
    }

    if (!firstMessage) {
      firstMessage = message;
      continue;
    }

    if (message.createdAtMs < firstMessage.createdAtMs) {
      firstMessage = message;
      continue;
    }

    if (
      message.createdAtMs === firstMessage.createdAtMs &&
      message.id < firstMessage.id
    ) {
      firstMessage = message;
    }
  }

  return firstMessage;
}

/**
 * Drop the oldest visible Messages until the working set fits the target, so
 * the Messages that each Turn loads stay bounded. This makes no model call.
 * Return whether a Message was dropped.
 */
export async function trimConversationMessages(
  conversation: ThreadConversationState,
  /** Load the seq after which a thread context delta still needs Messages. */
  loadKeepAfterSeq: () => Promise<number | undefined>,
): Promise<boolean> {
  let estimatedTokens = estimateConversationMessagesTokens(conversation);
  setSpanAttributes({ "app.context_tokens_estimated": estimatedTokens });
  const triggerTokens = getConversationContextCompactionTriggerTokens();
  if (estimatedTokens <= triggerTokens) return false;

  const targetTokens = calculateContextCompactionTargetTokens(triggerTokens);
  const keepAfterSeq = await loadKeepAfterSeq();
  const maxDropped = conversation.messages.length - CONTEXT_MIN_LIVE_MESSAGES;
  let dropped = 0;
  while (dropped < maxDropped && estimatedTokens > targetTokens) {
    const message = conversation.messages[dropped]!;
    if (
      keepAfterSeq !== undefined &&
      (message.seq === undefined || message.seq > keepAfterSeq)
    ) {
      break;
    }
    estimatedTokens -= estimateTextTokens(
      `${renderConversationMessageLine(message, conversation)}\n`,
    );
    dropped += 1;
  }
  if (dropped === 0) return false;

  conversation.messages = conversation.messages.slice(dropped);
  // Messages load in seq order, so the first kept Message starts the window.
  const historyFromSeq = conversation.messages[0]?.seq;
  if (historyFromSeq !== undefined) {
    conversation.historyFromSeq = historyFromSeq;
  }
  setSpanAttributes({
    "app.thread_messages.trimmed": dropped,
    "app.context_tokens_estimated":
      estimateConversationMessagesTokens(conversation),
  });
  return true;
}

export function isHumanConversationMessage(
  message: ConversationMessage,
): boolean {
  return message.role === "user" && message.author?.isBot !== true;
}

/** Return the native Slack timestamp for a persisted conversation message. */
export function getConversationMessageSlackTs(
  message: ConversationMessage,
): SlackMessageTs | undefined {
  return parseSlackMessageTs(message.meta?.slackTs);
}
