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
import {
  escapeTagTextAndQuotes,
  indentTagLines,
  renderTag,
} from "@sentry/junior-plugin-api";
import { authorAttrs, renderThreadContext } from "@/chat/input-tags";
import { isEventConversationMessage } from "@/chat/events/actor";

const CONTEXT_MIN_LIVE_MESSAGES = 12;
// Hard cap on the rendered thread context, newest Messages first. A Message
// is shown whole, unless it alone is larger than the cap.
const THREAD_CONTEXT_MAX_CHARS = 60_000;
const THREAD_CONTEXT_OMITTED_NOTE =
  "Older Messages of this thread are not shown. Find them with a searchConversationEvents query, then read them with readConversationEvent.";
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

function truncatedMessageNote(message: ConversationMessage): string {
  const reader = message.meta?.slackTs
    ? "slackThreadRead"
    : "a searchConversationEvents query, then readConversationEvent";
  return ` [truncated: this Message is longer than the thread context allows. Read it in full with ${reader}.]`;
}

function renderConversationMessageLine(
  message: ConversationMessage,
  conversation?: ThreadConversationState,
  /** Cut the Message text to this length and mark it as truncated. */
  maxTextChars?: number,
): string {
  const displayName = escapeTagTextAndQuotes(
    conversationAuthorDisplayName(message),
  );
  const fullText = message.text.replace(/\s+/g, " ");
  const text =
    maxTextChars !== undefined && fullText.length > maxTextChars
      ? `${escapeTagTextAndQuotes(fullText.slice(0, maxTextChars))}${truncatedMessageNote(message)}`
      : escapeTagTextAndQuotes(fullText);

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
  return `[${message.role}] ${displayName}: ${text}${imageContext}${markerSuffix}`;
}

function conversationAuthorDisplayName(message: ConversationMessage): string {
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
  const prefix = `${args.sessionId}:assistant:`;
  const ordinal =
    args.conversation.messages.filter((message) =>
      message.id.startsWith(prefix),
    ).length + 1;
  const messageId = `${prefix}${ordinal}`;
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
    },
  });
  return messageId;
}

/** Return whether a turn already has a destination-accepted assistant reply. */
export function turnHasReply(
  conversation: ThreadConversationState,
  turnId: string,
): boolean {
  const assistantPrefix = `${turnId}:assistant:`;
  return conversation.messages.some(
    (message) =>
      message.role === "assistant" && message.id.startsWith(assistantPrefix),
  );
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

// A take or a dismiss is not a decision, so it never reaches the model.
function isTakeOrDismissOnly(message: ConversationMessage): boolean {
  const changes = message.meta?.reviewItemChanges;
  return Boolean(
    changes?.length &&
    changes.every(
      (change) => change.kind === "taken" || change.kind === "dismissed",
    ),
  );
}

function renderThreadContextMessage(
  message: ConversationMessage,
  conversation: ThreadConversationState,
  index: number,
  maxTextChars?: number,
): string {
  return indentTagLines(
    renderTag(
      "message",
      {
        index,
        sent_at: new Date(message.createdAtMs).toISOString(),
        role: message.role,
        ...authorAttrs({
          authorId: message.author?.userId,
          authorName: conversationAuthorDisplayName(message),
        }),
        slack_ts: message.meta?.slackTs,
      },
      [renderConversationMessageLine(message, conversation, maxTextChars)],
    ),
    "  ",
  );
}

// Cut the text of a Message that alone is larger than the cap to the longest
// prefix that fits. Escaping can make text longer by a varying amount, so
// search for the prefix length instead of computing it.
function renderOversizedMessage(
  message: ConversationMessage,
  conversation: ThreadConversationState,
): string {
  const render = (maxTextChars: number) =>
    renderThreadContextMessage(message, conversation, 1, maxTextChars);
  let fits = 0;
  let over = THREAD_CONTEXT_MAX_CHARS;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (render(middle).length <= THREAD_CONTEXT_MAX_CHARS) {
      fits = middle;
    } else {
      over = middle;
    }
  }
  return render(fits);
}

// A Message that the agent history does not hold: no mention, no Event, and
// not Turn input. Backfilled Messages have no mention, so they count.
function isUntaggedThreadMessage(message: ConversationMessage): boolean {
  return (
    message.role === "user" &&
    !message.meta?.explicitMention &&
    !isEventConversationMessage(message)
  );
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

/** A rendered thread context block and the counts that telemetry reports. */
export interface ThreadContextBlock {
  text?: string;
  shownMessages: number;
  /** Messages that matched but did not fit under the size cap. */
  omittedMessages: number;
}

/**
 * Render the thread Messages that this Turn needs as one evidence-only block.
 *
 * With agent history, earlier Turns already hold their thread context, Turn
 * input, and replies. So only untagged Messages saved after the cursor of the
 * previous Turn are new. Without history, show the latest Messages. Both keep
 * the newest Messages under one hard size cap, so the block cannot grow with
 * the thread.
 */
export function buildConversationContext(
  conversation: ThreadConversationState,
  options: {
    /** Turn input Messages, which the prompt already holds. */
    excludeMessageIds?: readonly string[];
    /**
     * Set when agent history exists. `afterSeq` is the cursor of the previous
     * Turn. A Conversation from before cursors has none.
     */
    history?: { afterSeq?: number | undefined };
  } = {},
): ThreadContextBlock {
  const { history } = options;
  const candidates = conversation.messages.filter(
    (entry) =>
      !options.excludeMessageIds?.includes(entry.id) &&
      !isTakeOrDismissOnly(entry) &&
      (!history ||
        (isUntaggedThreadMessage(entry) &&
          (history.afterSeq === undefined ||
            entry.seq === undefined ||
            entry.seq > history.afterSeq))),
  );
  // Keep the newest Messages that fit. The index of a Message is its position
  // in the block.
  let first = candidates.length;
  let chars = 0;
  while (first > 0) {
    const size = renderThreadContextMessage(
      candidates[first - 1]!,
      conversation,
      first,
    ).length;
    if (chars + size > THREAD_CONTEXT_MAX_CHARS) break;
    chars += size;
    first -= 1;
  }
  const shown = candidates
    .slice(first)
    .map((message, index) =>
      renderThreadContextMessage(message, conversation, index + 1),
    );
  const newest = candidates.at(-1);
  if (shown.length === 0 && newest) {
    shown.push(renderOversizedMessage(newest, conversation));
  }
  const counts = {
    shownMessages: shown.length,
    omittedMessages: candidates.length - shown.length,
  };
  if (shown.length === 0) {
    return counts;
  }
  const lines = [renderThreadContext(shown)];
  // Trimming also drops older Messages from the working set.
  if (
    shown.length < candidates.length ||
    (!history && conversation.historyFromSeq !== undefined)
  ) {
    lines.push(THREAD_CONTEXT_OMITTED_NOTE);
  }
  return { ...counts, text: lines.join("\n") };
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
