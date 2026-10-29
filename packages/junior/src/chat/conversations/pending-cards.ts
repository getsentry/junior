import { getConversationEventStore, getDb } from "@/chat/db";
import { isRecord } from "@/chat/coerce";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import {
  getAgentInvocation,
  getAgentInvocationTurnId,
  parseAgentInvocationResultMessageId,
} from "@/chat/agent-invocations/store";
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
          selection.deleted.add(JSON.stringify([ref.plugin, ref.key]));
        }
      }
      for (const card of readMessageCardRefs(data.details)) {
        const key = JSON.stringify([card.plugin, card.key]);
        if (!selection.deleted.has(key) && !selection.cards.has(key)) {
          selection.cards.set(key, card);
        }
      }
    }
    if (!page.hasOlder || page.events.length === 0) return [];
    beforeSeq = page.events[0]!.seq;
  }
}

/**
 * Add the cards of child agents whose results started this Turn. A child
 * cannot reply to people, so its parent's reply delivers its cards.
 */
async function selectChildResultCards(
  inputMessageIds: readonly string[],
  selection: CardSelection,
): Promise<void> {
  const events = getConversationEventStore();
  for (const messageId of [...inputMessageIds].reverse()) {
    const invocationId = parseAgentInvocationResultMessageId(messageId);
    const invocation = invocationId
      ? await getAgentInvocation(invocationId)
      : undefined;
    if (!invocation) continue;
    const turnId = getAgentInvocationTurnId(invocation.invocationId);
    // The child records its terminal Turn event before it reports the result.
    const terminal = await events.loadByIdempotencyKey(
      invocation.childConversationId,
      `turn:${turnId}:terminal`,
    );
    if (!terminal) continue;
    await selectTurnCards(
      invocation.childConversationId,
      selection,
      terminal.seq,
    );
  }
}

/** Select undelivered cards and load their latest saved facts. */
export async function loadPendingMessageCards(
  conversationId: string,
): Promise<MessageCard[]> {
  const selection: CardSelection = { cards: new Map(), deleted: new Set() };
  const inputMessageIds = await selectTurnCards(conversationId, selection);
  await selectChildResultCards(inputMessageIds, selection);
  if (selection.cards.size === 0) return [];
  return resolveMessageCards(
    [...selection.cards.values()].reverse(),
    await listConversationAnnotations(getDb(), conversationId),
  );
}
