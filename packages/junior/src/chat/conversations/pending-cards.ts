import type { User } from "@sentry/junior-plugin-api";
import { and, sql } from "drizzle-orm";
import { readLiveAnnotations } from "@/api/objects/live-annotations";
import { getConversationEventStore, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import { juniorConversations } from "@/db/schema";
import { topLevelConversation } from "@/chat/conversations/sql/listed";
import { conversationAncestorsOrSelf } from "@/chat/conversations/sql/subtree";
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

// The person who started the top-level Conversation of this one, when
// Junior knows their User. In a Space that is the Lead's child, not the
// Lead: a thread moved into a Space keeps the person who started it, and
// only the Lead's own work reads as the Space's creator. System work, such
// as an Automation run, has none.
async function readConversationOwner(
  conversationId: string,
): Promise<User | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ identityId: juniorConversations.actorIdentityId })
    .from(juniorConversations)
    .where(
      and(
        sql<boolean>`${juniorConversations.conversationId} in ${conversationAncestorsOrSelf(sql`${conversationId}`)}`,
        topLevelConversation(),
      ),
    )
    .orderBy(sql`coalesce(${juniorConversations.kind} = 'lead', false)`)
    .limit(1);
  return row?.identityId
    ? (await readIdentityByIdFromSql(db, row.identityId))?.user
    : undefined;
}

/**
 * Select undelivered cards and read each object once, with the access of
 * the person who started the Conversation. The delivered Message keeps
 * that copy. A card whose object cannot be read that way shows only the
 * stored title, the label, and the link.
 */
export async function loadPendingMessageCards(
  conversationId: string,
): Promise<MessageCard[]> {
  const selection: CardSelection = { cards: new Map(), deleted: new Set() };
  const inputMessageIds = await selectTurnCards(conversationId, selection);
  await selectChildResultCards(conversationId, inputMessageIds, selection);
  if (selection.cards.size === 0) return [];
  const refs = [...selection.cards.values()].reverse();
  const selected = new Set(
    refs.map((ref) => JSON.stringify([ref.plugin, ref.key])),
  );
  const annotations = (
    await listConversationAnnotations(getDb(), conversationId)
  ).filter(
    (annotation) =>
      annotation.kind === "object" &&
      selected.has(JSON.stringify([annotation.plugin, annotation.key])),
  );
  return resolveMessageCards(
    refs,
    annotations.length > 0
      ? await readLiveAnnotations(
          await readConversationOwner(conversationId),
          annotations,
          "title",
        )
      : [],
  );
}
