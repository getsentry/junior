import type { User } from "@sentry/junior-plugin-api";
import {
  searchAutomationsForViewer,
  type AutomationSearchMatch,
} from "@/chat/automations/search";
import {
  searchInboxItemsForUser,
  type InboxItemSearchMatch,
} from "@/chat/inbox-items/search";
import {
  searchPublicMemories,
  type MemorySearchMatch,
} from "@/chat/memory/search";
import {
  searchTodosForViewer,
  type TodoSearchMatch,
} from "@/chat/todos/search";
import { parseTypedQuery } from "@/search/typed-query";

// One menu group. More rows do not help a person who is still typing.
const OMNI_SEARCH_SOURCE_LIMIT = 8;

/** A kind of record that one search finds. */
export type OmniSearchSource =
  | "automations"
  | "inboxItems"
  | "memories"
  | "todos";

/** The matches of each source that a search named, best first. */
export type OmniSearchResults = {
  automations?: AutomationSearchMatch[];
  inboxItems?: InboxItemSearchMatch[];
  memories?: MemorySearchMatch[];
  todos?: TodoSearchMatch[];
};

/**
 * Search the named sources for text that a person types, as `viewer`. Each
 * source returns only what its own page shows the viewer, ranked by the
 * shared search ranking, and the sources read at once. Text with no letters
 * or digits matches nothing and reads nothing.
 */
export async function omniSearch(input: {
  sources: readonly OmniSearchSource[];
  text: string;
  viewer: User;
}): Promise<OmniSearchResults> {
  const query = parseTypedQuery(input.text);
  const wants = (source: OmniSearchSource) => input.sources.includes(source);
  const [automations, inboxItems, memories, todos] = await Promise.all([
    query && wants("automations")
      ? searchAutomationsForViewer(
          input.viewer,
          query,
          OMNI_SEARCH_SOURCE_LIMIT,
        )
      : [],
    query && wants("inboxItems")
      ? searchInboxItemsForUser(input.viewer, query, OMNI_SEARCH_SOURCE_LIMIT)
      : [],
    query && wants("memories")
      ? searchPublicMemories(input.text, OMNI_SEARCH_SOURCE_LIMIT)
      : [],
    query && wants("todos")
      ? searchTodosForViewer(input.viewer, query, OMNI_SEARCH_SOURCE_LIMIT)
      : [],
  ]);
  return {
    ...(wants("automations") ? { automations } : undefined),
    ...(wants("inboxItems") ? { inboxItems } : undefined),
    ...(wants("memories") ? { memories } : undefined),
    ...(wants("todos") ? { todos } : undefined),
  };
}
