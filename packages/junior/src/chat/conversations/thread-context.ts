import { getConversationEventStore } from "@/chat/db";
import { setSpanAttributes } from "@/chat/logging";
import { buildConversationContext } from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";

// Turns that the cursor lookup reads, newest first.
const CURSOR_TURN_LOOKBACK = 10;

// The Message seq that the thread context of the latest other finished Turn
// covered. A failed or cancelled Turn may not have its prompt in agent history,
// so its cursor does not count. Showing a Message again is safe; skipping one
// that the model never saw is not.
async function loadThreadContextCursor(args: {
  conversationId: string;
  turnId: string;
}): Promise<number | undefined> {
  const store = getConversationEventStore();
  const [started, completed] = await Promise.all([
    store.query(args.conversationId, {
      limit: CURSOR_TURN_LOOKBACK,
      types: ["turn_started"],
    }),
    store.query(args.conversationId, {
      limit: CURSOR_TURN_LOOKBACK,
      types: ["turn_completed"],
    }),
  ]);
  const finished = new Set(
    completed.events.flatMap((event) =>
      event.data.type === "turn_completed" && event.data.outcome !== "cancelled"
        ? [event.data.turnId]
        : [],
    ),
  );
  const previous = [...started.events]
    .reverse()
    .find(
      (event) =>
        event.data.type === "turn_started" &&
        event.data.turnId !== args.turnId &&
        finished.has(event.data.turnId),
    );
  return previous?.data.type === "turn_started"
    ? previous.data.threadContextThroughSeq
    : undefined;
}

/**
 * Return the oldest cursor of the Turns that the cursor lookup reads. Messages
 * after it may still be in the thread context delta of the next Turn, also
 * when the latest Turns failed or the next Turn retries.
 */
export async function loadThreadContextTrimFloor(
  conversationId: string,
): Promise<number | undefined> {
  const page = await getConversationEventStore().query(conversationId, {
    limit: CURSOR_TURN_LOOKBACK,
    types: ["turn_started"],
  });
  const cursors = page.events.flatMap((event) =>
    event.data.type === "turn_started" &&
    event.data.threadContextThroughSeq !== undefined
      ? [event.data.threadContextThroughSeq]
      : [],
  );
  return cursors.length > 0 ? Math.min(...cursors) : undefined;
}

/**
 * Build the thread context of one Turn prompt. With agent history, show only
 * the thread Messages saved after the cursor of the previous Turn.
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
