import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemConversations, juniorInboxItems } from "@/db/schema";
import { inboxItemVisibleTo, type InboxItemReader } from "./access";
import { ownerConversationId, type InboxItem } from "./store";
import { subjectKindPlugin } from "./subjects";

// Each item keeps at most this many related items, newest first.
const RELATED_ITEM_LIMIT = 10;
// The reads keep this many of the newest candidates for each object and
// linked Conversation, so a busy object cannot crowd out
// the other items on the page. One more than the item limit, because an
// item can be a candidate for its own object.
const RELATED_CANDIDATE_LIMIT = RELATED_ITEM_LIMIT + 1;

/** Other open work on the same object or linked work as one item. */
export interface RelatedReviewWork {
  /**
   * The item's linked Conversations other than the one that added it, that
   * the viewer can see.
   */
  conversationIds: string[];
  /** Other open items that the reader can see, newest first. */
  items: Array<{ id: string; title: string }>;
}

type Candidate = {
  createdAt: Date;
  id: string;
  title: string;
};

/** The linked Conversations of an item that point to other work. */
function linkedWork(item: InboxItem): string[] {
  return item.conversationIds.filter((id) => id !== ownerConversationId(item));
}

function openVisible(reader: InboxItemReader): SQL {
  return and(eq(juniorInboxItems.status, "open"), inboxItemVisibleTo(reader))!;
}

/** Rank the candidates in each group, newest first. */
function newestInGroup(group: AnyPgColumn) {
  return sql<number>`row_number() over (partition by ${group} order by ${juniorInboxItems.createdAt} desc, ${juniorInboxItems.id} desc)`;
}

const candidateColumns = {
  createdAt: juniorInboxItems.createdAt,
  id: juniorInboxItems.id,
  title: juniorInboxItems.title,
};

/**
 * The outside object that a plugin item is about, which related work
 * matches: its subject id, such as a pull request. A question's evidence
 * links show on its card, but they relate it to no other item. Other core
 * kinds relate to nothing by object.
 */
function relatedObjects(item: InboxItem): string[] {
  return subjectKindPlugin(item.subject.kind) ? [item.subject.id] : [];
}

/**
 * Read the related work of each open item in a page: the other open plugin
 * items that the reader can see about the same object
 * (`relatedObjects`), or in one of the Conversations that the item links,
 * and the linked Conversations when the viewer can see them. The reads
 * cover the whole page at once, so the query count does not grow with the
 * page.
 */
export async function readRelatedReviewWork(
  db: JuniorDatabase,
  reader: InboxItemReader,
  viewer: User,
  items: readonly InboxItem[],
): Promise<Map<string, RelatedReviewWork>> {
  const open = items.filter((item) => item.status === "open");
  const objects = [...new Set(open.flatMap(relatedObjects))];
  const linkIds = [...new Set(open.flatMap(linkedWork))];
  const objectRanks = db
    .select({
      ...candidateColumns,
      subjectId: juniorInboxItems.subjectId,
      rank: newestInGroup(juniorInboxItems.subjectId).as("object_rank"),
    })
    .from(juniorInboxItems)
    .where(
      and(
        openVisible(reader),
        // Only a plugin kind names an outside object.
        like(juniorInboxItems.subjectKind, "%:%"),
        inArray(juniorInboxItems.subjectId, objects),
      ),
    )
    .as("object_ranks");
  const linkRanks = db
    .select({
      ...candidateColumns,
      conversationId: juniorInboxItemConversations.conversationId,
      rank: newestInGroup(juniorInboxItemConversations.conversationId).as(
        "link_rank",
      ),
    })
    .from(juniorInboxItemConversations)
    .innerJoin(
      juniorInboxItems,
      eq(juniorInboxItems.id, juniorInboxItemConversations.itemId),
    )
    .where(
      and(
        inArray(juniorInboxItemConversations.conversationId, linkIds),
        openVisible(reader),
      ),
    )
    .as("link_ranks");
  const [byObject, byLink, access] = await Promise.all([
    objects.length > 0
      ? db
          .select({
            createdAt: objectRanks.createdAt,
            id: objectRanks.id,
            subjectId: objectRanks.subjectId,
            title: objectRanks.title,
          })
          .from(objectRanks)
          .where(lte(objectRanks.rank, RELATED_CANDIDATE_LIMIT))
      : [],
    linkIds.length > 0
      ? db
          .select({
            conversationId: linkRanks.conversationId,
            createdAt: linkRanks.createdAt,
            id: linkRanks.id,
            title: linkRanks.title,
          })
          .from(linkRanks)
          .where(lte(linkRanks.rank, RELATED_CANDIDATE_LIMIT))
      : [],
    readConversationAccessFromSql(db, linkIds, viewer),
  ]);
  const related = new Map<string, RelatedReviewWork>();
  for (const item of open) {
    const about = new Set(relatedObjects(item));
    const work = new Set(linkedWork(item));
    const matches = new Map<string, Candidate>();
    for (const candidate of byObject) {
      if (about.has(candidate.subjectId)) matches.set(candidate.id, candidate);
    }
    for (const candidate of byLink) {
      if (work.has(candidate.conversationId)) {
        matches.set(candidate.id, candidate);
      }
    }
    matches.delete(item.id);
    related.set(item.id, {
      conversationIds: linkedWork(item).filter(
        (id) => access.get(id)?.canViewPrivateContent === true,
      ),
      items: [...matches.values()]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        )
        .slice(0, RELATED_ITEM_LIMIT)
        .map(({ id, title }) => ({ id, title })),
    });
  }
  return related;
}
