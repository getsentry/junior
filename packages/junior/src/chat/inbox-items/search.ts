import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { juniorInboxItems } from "@/db/schema";
import {
  inboxItemFuzzyTitle,
  inboxItemSearchDocument,
} from "@/db/schema/inbox-items";
import { rankSearchMatches, scoredSearchMatches } from "@/search/match-ranking";
import {
  fuzzyMatch,
  fuzzyRank,
  prefixMatch,
  prefixRank,
  SEARCH_RANK_WINDOW,
} from "@/search/text-match";
import type { TypedQuery } from "@/search/typed-query";
import {
  inboxItemForUser,
  inboxItemReaderForUser,
  inboxItemVisibleTo,
} from "./access";

/** An Inbox item that matches a search. */
export type InboxItemSearchMatch = Pick<
  typeof juniorInboxItems.$inferSelect,
  "id" | "status" | "title"
>;

/**
 * Find the items of the viewer's own Inbox, open and closed, as the Inbox
 * shows them. A word of the title or body starts with each word of the
 * query, or the title is close to the query despite a typo. Open items come
 * first, each group best match first. Reads the GIN indexes
 * `junior_inbox_items_search_idx` and `junior_inbox_items_title_trgm_idx`.
 */
export async function searchInboxItemsForUser(
  viewer: User,
  query: TypedQuery,
  limit: number,
): Promise<InboxItemSearchMatch[]> {
  const db = getDb();
  const items = juniorInboxItems;
  // The newest matches, before any is ranked.
  const candidates = db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        or(
          prefixMatch(inboxItemSearchDocument(items), query),
          fuzzyMatch(inboxItemFuzzyTitle(items), query),
        ),
        inboxItemVisibleTo(inboxItemReaderForUser(viewer)),
        inboxItemForUser(viewer.id),
      ),
    )
    .orderBy(desc(items.updatedAt), desc(items.id))
    .limit(SEARCH_RANK_WINDOW)
    .as("inbox_item_candidates");
  const item = alias(juniorInboxItems, "inbox_item");
  const document = inboxItemSearchDocument(item);
  const title = inboxItemFuzzyTitle(item);
  const rows = await db
    .select({
      fuzzy: fuzzyRank(title, query),
      fuzzyMatched: fuzzyMatch(title, query),
      id: item.id,
      lexical: prefixRank(document, query),
      lexicalMatched: prefixMatch(document, query),
      status: item.status,
      title: item.title,
      updatedAt: item.updatedAt,
    })
    .from(candidates)
    .innerJoin(item, eq(item.id, candidates.id));
  const ranked = rankSearchMatches(
    scoredSearchMatches(rows, {
      fuzzy: (row) => (row.fuzzyMatched ? Number(row.fuzzy) : undefined),
      lexical: (row) => (row.lexicalMatched ? Number(row.lexical) : undefined),
    }),
    {
      key: (row) => row.id,
      tiebreak: (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        right.id.localeCompare(left.id),
    },
  );
  return [
    ...ranked.filter((row) => row.status === "open"),
    ...ranked.filter((row) => row.status !== "open"),
  ]
    .slice(0, limit)
    .map((row) => ({ id: row.id, status: row.status, title: row.title }));
}
