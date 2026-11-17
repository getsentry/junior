/**
 * Keyword search alone for a `searchConversationEvents` call of the agent.
 *
 * Event search fuses keyword and meaning ranks. A case that proves meaning
 * search compares the agent's result with what keyword search alone returns
 * for the same input. It runs the product search without an embedder.
 */
import * as z from "zod";
import { searchConversationEventText } from "@/chat/conversations/event-search";
import {
  KNOWN_CONVERSATION_EVENT_TYPES,
  type ConversationEvent,
} from "@/chat/conversations/history";
import { getDb } from "@/chat/db";
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
  const matches = await searchConversationEventText(getDb(), {
    conversationId,
    limit: search.limit ?? DEFAULT_EVENT_SEARCH_LIMIT,
    query: search.query,
    ...(search.after_seq == null ? undefined : { afterSeq: search.after_seq }),
    ...(search.before_seq == null
      ? undefined
      : { beforeSeq: search.before_seq }),
    ...(search.types ? { types: search.types } : undefined),
  });
  return matches.map((match) => match.event);
}
