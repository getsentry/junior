import { getConversationEventStore, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { listChildMessages } from "@/chat/child-agents/child-message";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { mapBounded } from "@/chat/fan-out";
import {
  readMessageCardRefs,
  removedCardSchema,
  resolveMessageCards,
  type MessageCard,
  type MessageCardRef,
} from "./cards";

/** Card selections, newest first. A newer selection or removal wins. */
interface CardSelection {
  cards: Map<string, MessageCardRef>;
  deleted: Set<string>;
}

/**
 * Add the cards that tool results selected since the last visible assistant
 * Message or Turn start, scanning back from `beforeSeq`. Returns the input
 * message ids of the Turn start that ended the scan.
 */
async function selectTurnCards(
  conversationId: string,
  selection: CardSelection,
  beforeSeq?: number,
): Promise<string[]> {
  // Tools are committed before Delivery. A visible assistant Message consumes
  // the cards; a new Turn must not inherit cards from an earlier silent Turn.
  /* oxlint-disable no-await-in-loop -- Each page starts before the oldest event of the page before. */
  while (true) {
    const page = await getConversationEventStore().query(conversationId, {
      beforeSeq,
      limit: 100,
      types: ["tool_result", "message", "turn_started"],
    });
    for (const event of [...page.events].reverse()) {
      const data = event.data;
      if (data.type === "turn_started") return data.inputMessageIds;
      if (data.type === "message" && data.role === "assistant") return [];
      if (
        data.type !== "tool_result" ||
        data["isError"] ||
        typeof data["toolName"] !== "string"
      )
        continue;
      const details = data["details"];
      if (typeof details !== "object" || details === null) continue;
      if ("timed_out" in details && details.timed_out === true) continue;
      if ("removedCards" in details && Array.isArray(details.removedCards)) {
        for (const ref of removedCardSchema
          .array()
          .parse(details.removedCards)) {
          selection.deleted.add(JSON.stringify([ref.plugin, ref.key]));
        }
      }
      for (const card of readMessageCardRefs(details)) {
        const key = JSON.stringify([card.plugin, card.key]);
        if (!selection.deleted.has(key) && !selection.cards.has(key)) {
          selection.cards.set(key, card);
        }
      }
    }
    if (!page.hasOlder || page.events.length === 0) return [];
    beforeSeq = page.events[0]!.seq;
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * Add the cards of child agents whose replies or results started this Turn.
 * A child cannot reply to people, so its parent's reply delivers its cards.
 */
async function selectChildResultCards(
  conversationId: string,
  inputMessageIds: readonly string[],
  selection: CardSelection,
): Promise<void> {
  if (inputMessageIds.length === 0) return;
  const events = getConversationEventStore();
  const execution = (await getConversationWorkState({ conversationId }))
    ?.execution;
  const messages = listChildMessages(
    inputMessageIds,
    execution?.messageSenders ?? {},
  );
  messages.reverse();
  // The child records its terminal Turn event before it reports the result.
  const terminals = await mapBounded(messages, ({ sender }) =>
    events.loadByIdempotencyKey(
      sender.conversationId,
      `turn:${sender.turnId}:terminal`,
    ),
  );
  for (const [index, message] of messages.entries()) {
    const terminal = terminals[index];
    // A child's result can reach the parent before the child records the end
    // of its Turn. Then its cards are the newest ones.
    // oxlint-disable-next-line no-await-in-loop -- Newer child results select cards first.
    await selectTurnCards(
      message.sender.conversationId,
      selection,
      terminal?.seq,
    );
  }
}

/** Select undelivered cards and load their latest saved facts. */
export async function loadPendingMessageCards(
  conversationId: string,
): Promise<MessageCard[]> {
  const selection: CardSelection = { cards: new Map(), deleted: new Set() };
  const inputMessageIds = await selectTurnCards(conversationId, selection);
  await selectChildResultCards(conversationId, inputMessageIds, selection);
  if (selection.cards.size === 0) return [];
  return resolveMessageCards(
    [...selection.cards.values()].reverse(),
    await listConversationAnnotations(getDb(), conversationId),
  );
}
