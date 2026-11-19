// The only file in core that imports `chat/`. Chat owns the Conversation event
// format and its one writer, `SqlConversationEventStore.append`. Main changes
// that code often, so a copy in core would drift and break history loads.
// Remove this file when core owns Conversation history.
import type { Message } from "@earendil-works/pi-ai";
import { contextProvenance } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { JuniorSqlDatabase } from "@/db/db";

export { withConversationEventLock } from "@/chat/conversations/sql/event-lock";

/** Appends a step's messages to the Conversation history, as chat's runtime stores them. */
export async function appendStepMessages(
  executor: JuniorSqlDatabase,
  conversationId: string,
  messages: Message[],
): Promise<void> {
  await createSqlConversationEventStore(executor).append(
    conversationId,
    messages.map((message) => ({
      data: historyItemFromPiMessage(message, contextProvenance),
      createdAtMs: message.timestamp,
    })),
  );
}
