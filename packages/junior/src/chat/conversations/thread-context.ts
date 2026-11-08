import { getConversationEventStore } from "@/chat/db";
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
 * Build the thread context of one Turn prompt. With agent history, show only
 * the thread Messages saved after the cursor of the previous Turn.
 */
export async function buildTurnThreadContext(args: {
  conversation: ThreadConversationState;
  conversationId: string;
  /** Turn input Messages, which the prompt already holds. */
  excludeMessageIds: readonly string[];
  hasHistory: boolean;
  turnId: string;
}): Promise<string | undefined> {
  return buildConversationContext(args.conversation, {
    excludeMessageIds: args.excludeMessageIds,
    ...(args.hasHistory
      ? {
          history: {
            afterSeq: await loadThreadContextCursor({
              conversationId: args.conversationId,
              turnId: args.turnId,
            }),
          },
        }
      : undefined),
  });
}
