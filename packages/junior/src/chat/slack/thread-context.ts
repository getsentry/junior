import { isHeldInputMessage } from "@/chat/conversations/held-input";
import { loadThreadContextCursor } from "@/chat/conversations/thread-context";
import { isEventConversationMessage } from "@/chat/events/actor";
import { authorAttrs, renderThreadContext } from "@/chat/input-tags";
import { setSpanAttributes } from "@/chat/logging";
import {
  conversationAuthorDisplayName,
  renderConversationMessageLine,
} from "@/chat/services/conversation-memory";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { indentTagLines, renderTag } from "@sentry/junior-plugin-api";

// Thread context holds the Messages of a Slack thread that did not mention
// Junior, so the agent history does not hold them.

// Most characters of one Message. A longer Message is cut and marked, so the
// model knows to read it in full.
const CONTEXT_MAX_MESSAGE_CHARS = 8_000;
const TRUNCATED_MESSAGE_NOTE =
  " [truncated: read the full Message with slackThreadRead]";
// Hard cap on the rendered thread context, newest Messages first.
const THREAD_CONTEXT_MAX_CHARS = 60_000;
const THREAD_CONTEXT_OMITTED_NOTE =
  "Older Messages of this thread are not shown. Find them with a searchConversationEvents query, then read them with readConversationEvent.";

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
      [
        renderConversationMessageLine(
          message,
          conversation,
          message.text.length > CONTEXT_MAX_MESSAGE_CHARS
            ? `${message.text.slice(0, CONTEXT_MAX_MESSAGE_CHARS)}${TRUNCATED_MESSAGE_NOTE}`
            : message.text,
        ),
      ],
    ),
    "  ",
  );
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

/** A rendered thread context block and the counts that telemetry reports. */
interface ThreadContextBlock {
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
      // Held input reaches the next Turn as Turn input.
      !isHeldInputMessage(entry) &&
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

/**
 * Build the thread context of one Turn prompt in a Slack thread. With agent
 * history, show only the thread Messages saved after the cursor of the
 * previous Turn.
 *
 * Sets `app.thread_context.*` on the active span: `chat.reply` in a Slack
 * Turn, `chat.turn` in a web or Event Turn. Cursor `missing` means that the
 * previous Turn ran before cursors existed.
 */
export async function buildTurnThreadContext(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  /** Turn input Messages, which the prompt already holds. */
  excludeMessageIds: readonly string[];
  hasHistory: boolean;
  turnId: string;
}): Promise<string | undefined> {
  const afterSeq = args.hasHistory
    ? await loadThreadContextCursor({
        conversationId: args.conversationId,
        turnId: args.turnId,
      })
    : undefined;
  const block = buildConversationContext(args.conversation, {
    excludeMessageIds: args.excludeMessageIds,
    ...(args.hasHistory ? { history: { afterSeq } } : undefined),
  });
  setSpanAttributes({
    "app.thread_context.chars": block.text?.length ?? 0,
    "app.thread_context.shown_messages": block.shownMessages,
    "app.thread_context.omitted_messages": block.omittedMessages,
    "app.thread_context.cursor": !args.hasHistory
      ? "no_history"
      : afterSeq === undefined
        ? "missing"
        : "found",
  });
  return block.text;
}
