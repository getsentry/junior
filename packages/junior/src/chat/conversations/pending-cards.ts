import { getConversationEventStore, getDb } from "@/chat/db";
import { isRecord } from "@/chat/coerce";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import {
  readMessageCardRefs,
  removedCardSchema,
  resolveMessageCards,
  type MessageCard,
  type MessageCardRef,
} from "./cards";

/** Select undelivered cards and load their latest saved facts. */
export async function loadPendingMessageCards(
  conversationId: string,
): Promise<MessageCard[]> {
  const cards = new Map<string, MessageCardRef>();
  const deleted = new Set<string>();
  let beforeSeq: number | undefined;
  // Tools are committed before Delivery. A visible assistant Message consumes
  // the cards; a new Turn must not inherit cards from an earlier silent Turn.
  selection: while (true) {
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
        break selection;
      }
      if (
        data.type !== "tool_result" ||
        data.isError ||
        typeof data.toolName !== "string" ||
        !isRecord(data.details)
      )
        continue;
      if (data.details.timed_out === true) continue;
      if (Array.isArray(data.details.removedCards)) {
        for (const ref of removedCardSchema
          .array()
          .parse(data.details.removedCards)) {
          deleted.add(JSON.stringify([ref.plugin, ref.key]));
        }
      }
      for (const card of readMessageCardRefs(data.details)) {
        const key = JSON.stringify([card.plugin, card.key]);
        if (!deleted.has(key) && !cards.has(key)) cards.set(key, card);
      }
    }
    if (!page.hasOlder || page.events.length === 0) break;
    beforeSeq = page.events[0]!.seq;
  }
  if (cards.size === 0) return [];
  return resolveMessageCards(
    [...cards.values()].reverse(),
    await listConversationAnnotations(getDb(), conversationId),
  );
}
