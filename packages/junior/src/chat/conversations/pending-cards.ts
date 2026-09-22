import { getConversationEventStore } from "@/chat/db";
import { isRecord } from "@/chat/coerce";
import { messageCardSchema, type MessageCard } from "./cards";

const CARD_TOOLS = new Set([
  "createEventAutomation",
  "updateEventAutomation",
  "deleteEventAutomation",
  "slackScheduleCreateAutomation",
  "slackScheduleUpdateAutomation",
  "slackScheduleDeleteAutomation",
]);

/** Read undelivered card snapshots across resume and history replacement. */
export async function loadPendingMessageCards(
  conversationId: string,
): Promise<MessageCard[]> {
  const cards = new Map<string, MessageCard>();
  let beforeSeq: number | undefined;
  // Tools are committed before Delivery. A visible assistant Message consumes
  // the cards; a new Turn must not inherit cards from an earlier silent Turn.
  while (true) {
    const page = await getConversationEventStore().query(conversationId, {
      beforeSeq,
      limit: 100,
      types: ["tool_result", "message", "turn_started"],
    });
    for (const event of [...page.events].reverse()) {
      const data = event.data;
      if (
        data.type === "turn_started" ||
        (data.type === "message" && data.role === "assistant")
      ) {
        return [...cards.values()].reverse();
      }
      if (
        data.type !== "tool_result" ||
        data.isError ||
        typeof data.toolName !== "string" ||
        !CARD_TOOLS.has(data.toolName) ||
        !isRecord(data.details) ||
        !Array.isArray(data.details.cards)
      )
        continue;
      for (const value of data.details.cards) {
        const card = messageCardSchema.parse(value);
        if (!cards.has(card.id)) cards.set(card.id, card);
      }
    }
    if (!page.hasOlder || page.events.length === 0)
      return [...cards.values()].reverse();
    beforeSeq = page.events[0]!.seq;
  }
}
