// The replies of a Turn: its steps' assistant messages that deliver text.
// Each step event's idempotency key names its Turn, so a Turn's replies are
// found without reading the rest of the Conversation history.
import { and, asc, eq, like } from "drizzle-orm";
import { eventFromRow } from "@/chat/conversations/sql/history";
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import type { EngineContext } from "@/core/engine-context";
import { juniorConversationEvents } from "@/db/schema";

type EventRow = typeof juniorConversationEvents.$inferSelect;

/** The key prefix of the message events that a Turn's steps wrote. */
export function turnEventKeyPrefix(turnId: string): string {
  return `step:${turnId}:`;
}

/** The text that a message event delivers, or undefined when it is no reply. */
export function replyText(row: EventRow): string | undefined {
  const { data } = eventFromRow(row);
  if (data.type !== "assistant_message") {
    return undefined;
  }
  const message = piMessageFromHistoryItem(data);
  return message.role === "assistant"
    ? getAssistantReplyText(message)
    : undefined;
}

/** Finds the reply events of a Turn, in history order. */
export async function findTurnReplies(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  turnId: string,
): Promise<EventRow[]> {
  const events = await executor
    .db()
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "assistant_message"),
        like(
          juniorConversationEvents.idempotencyKey,
          `${turnEventKeyPrefix(turnId)}%`,
        ),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  return events.filter((row) => replyText(row) !== undefined);
}
