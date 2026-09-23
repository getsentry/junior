import { getConversationEventStore } from "@/chat/db";
import { isRecord } from "@/chat/coerce";
import { readMessageCards, type MessageCard } from "./cards";

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
  const deleted = new Set<string>();
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
        !isRecord(data.details)
      )
        continue;
      if (
        data.toolName === "deleteEventAutomation" ||
        data.toolName === "slackScheduleDeleteAutomation"
      ) {
        if (
          isRecord(data.details.automation) &&
          typeof data.details.automation.id === "string"
        ) {
          deleted.add(data.details.automation.id);
        }
        continue;
      }
      if (!Array.isArray(data.details.cards)) continue;
      for (const card of readMessageCards(data.details.cards)) {
        const key = `${card.kind}:${card.id}`;
        if (!deleted.has(card.id) && !cards.has(key)) cards.set(key, card);
      }
    }
    if (!page.hasOlder || page.events.length === 0)
      return [...cards.values()].reverse();
    beforeSeq = page.events[0]!.seq;
  }
}
