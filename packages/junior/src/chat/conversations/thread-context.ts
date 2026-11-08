import { getConversationEventStore } from "@/chat/db";
import { buildConversationContext } from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";

// The Message seq that the thread context of the latest other Turn covered.
async function loadThreadContextCursor(args: {
  conversationId: string;
  turnId: string;
}): Promise<number | undefined> {
  // A retried Turn already has its own `turn_started`, so read two.
  const page = await getConversationEventStore().query(args.conversationId, {
    limit: 2,
    types: ["turn_started"],
  });
  const previous = [...page.events]
    .reverse()
    .find(
      (event) =>
        event.data.type === "turn_started" && event.data.turnId !== args.turnId,
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
