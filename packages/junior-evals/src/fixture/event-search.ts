/**
 * Keyword search alone for a `searchConversationEvents` call of the agent.
 *
 * Event search fuses keyword and meaning ranks. A case that proves meaning
 * search compares the agent's result with what keyword search alone returns
 * for the same input. It runs the product search without an embedder, over
 * the events before the latest Turn: the events that the agent's searches in
 * that Turn look for. The agent's own events in that Turn, such as its reply,
 * came after its first search.
 */
import * as z from "zod";
import { searchConversationEventText } from "@/chat/conversations/event-search";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { getConversationEventStore, getDb } from "@/chat/db";
import { DEFAULT_EVENT_SEARCH_LIMIT } from "@/chat/tools/search-conversation-events";

// The fields of the tool input that change what the search returns.
const searchInputSchema = z.object({
  after_seq: z.number().int().nullish(),
  before_seq: z.number().int().nullish(),
  limit: z.number().int().nullish(),
  query: z.string().nullish(),
  types: z.array(z.enum(KNOWN_CONVERSATION_EVENT_TYPES)).nullish(),
});

/** Return the events that keyword search alone finds for the agent's search input. */
export async function keywordSearchEvents(
  conversationId: string,
  input: unknown,
): Promise<ConversationEvent[]> {
  const search = searchInputSchema.parse(input ?? {});
  if (!search.query) return [];
  const latestTurn = await getConversationEventStore().query(conversationId, {
    limit: 1,
    types: ["turn_started"],
  });
  const turnSeq = latestTurn.events[0]?.seq;
  const beforeSeq =
    turnSeq === undefined
      ? (search.before_seq ?? undefined)
      : Math.min(turnSeq, search.before_seq ?? turnSeq);
  const matches = await searchConversationEventText(getDb(), {
    conversationId,
    limit: search.limit ?? DEFAULT_EVENT_SEARCH_LIMIT,
    query: search.query,
    ...(search.after_seq == null ? undefined : { afterSeq: search.after_seq }),
    ...(beforeSeq === undefined ? undefined : { beforeSeq }),
    ...(search.types ? { types: search.types } : undefined),
  });
  return matches.map((match) => match.event);
}
