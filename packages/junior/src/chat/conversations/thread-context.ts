import { getConversationEventStore } from "@/chat/db";

// Turns that the cursor lookup reads, newest first.
const CURSOR_TURN_LOOKBACK = 10;

/**
 * Return the Message seq that the latest other finished Turn covered. A failed
 * or cancelled Turn may not have its prompt in agent history, so its cursor
 * does not count. Showing a Message again is safe; skipping one that the model
 * never saw is not.
 */
export async function loadThreadContextCursor(args: {
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
