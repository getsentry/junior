import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemConversations, juniorInboxItems } from "@/db/schema";
import { inboxItemVisibleTo, type InboxItemReader } from "./access";
import { ownerConversationId, type InboxItem } from "./store";

// Each item keeps at most this many related items, newest first.
const RELATED_ITEM_LIMIT = 10;
// The reads keep this many of the newest candidates for each subject id,
// subject URL, and linked Conversation, so a busy subject cannot crowd out
// the other items on the page. One more than the item limit, because an
// item can be a candidate for its own subject.
const RELATED_CANDIDATE_LIMIT = RELATED_ITEM_LIMIT + 1;

/** Other open work on the same subject or linked work as one item. */
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
  subjectId: string | null;
  subjectUrl: string | null;
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
  subjectId: juniorInboxItems.subjectId,
  subjectUrl: juniorInboxItems.subjectUrl,
  title: juniorInboxItems.title,
};

/**
 * Read the related work of each open item in a page: the other open items
 * that the reader can see with the same subject id or URL, or linked to one
 * of the item's other linked Conversations, and those Conversations when the
 * viewer can see them. The reads cover the whole page at once, so the query
 * count does not grow with the page.
 */
export async function readRelatedReviewWork(
  db: JuniorDatabase,
  reader: InboxItemReader,
  viewer: User,
  items: readonly InboxItem[],
): Promise<Map<string, RelatedReviewWork>> {
  const open = items.filter((item) => item.status === "open");
  const subjectIds = [
    ...new Set(open.flatMap((item) => item.subject?.id ?? [])),
  ];
  const subjectUrls = [
    ...new Set(open.flatMap((item) => item.subject?.url ?? [])),
  ];
  const linkIds = [...new Set(open.flatMap(linkedWork))];
  const subjectRanks = db
    .select({
      ...candidateColumns,
      idRank: newestInGroup(juniorInboxItems.subjectId).as("id_rank"),
      urlRank: newestInGroup(juniorInboxItems.subjectUrl).as("url_rank"),
    })
    .from(juniorInboxItems)
    .where(
      and(
        openVisible(reader),
        or(
          ...(subjectIds.length > 0
            ? [inArray(juniorInboxItems.subjectId, subjectIds)]
            : []),
          ...(subjectUrls.length > 0
            ? [inArray(juniorInboxItems.subjectUrl, subjectUrls)]
            : []),
        ),
      ),
    )
    .as("subject_ranks");
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
  const [bySubject, byLink, access] = await Promise.all([
    subjectIds.length > 0 || subjectUrls.length > 0
      ? db
          .select({
            createdAt: subjectRanks.createdAt,
            id: subjectRanks.id,
            subjectId: subjectRanks.subjectId,
            subjectUrl: subjectRanks.subjectUrl,
            title: subjectRanks.title,
          })
          .from(subjectRanks)
          .where(
            or(
              ...(subjectIds.length > 0
                ? [
                    and(
                      inArray(subjectRanks.subjectId, subjectIds),
                      lte(subjectRanks.idRank, RELATED_CANDIDATE_LIMIT),
                    ),
                  ]
                : []),
              ...(subjectUrls.length > 0
                ? [
                    and(
                      inArray(subjectRanks.subjectUrl, subjectUrls),
                      lte(subjectRanks.urlRank, RELATED_CANDIDATE_LIMIT),
                    ),
                  ]
                : []),
            ),
          )
      : [],
    linkIds.length > 0
      ? db
          .select({
            conversationId: linkRanks.conversationId,
            createdAt: linkRanks.createdAt,
            id: linkRanks.id,
            subjectId: linkRanks.subjectId,
            subjectUrl: linkRanks.subjectUrl,
            title: linkRanks.title,
          })
          .from(linkRanks)
          .where(lte(linkRanks.rank, RELATED_CANDIDATE_LIMIT))
      : [],
    readConversationAccessFromSql(db, linkIds, viewer),
  ]);
  const related = new Map<string, RelatedReviewWork>();
  for (const item of open) {
    const links = new Set(linkedWork(item));
    const matches = new Map<string, Candidate>();
    for (const candidate of bySubject) {
      if (
        (item.subject?.id && candidate.subjectId === item.subject.id) ||
        (item.subject?.url && candidate.subjectUrl === item.subject.url)
      ) {
        matches.set(candidate.id, candidate);
      }
    }
    for (const candidate of byLink) {
      if (links.has(candidate.conversationId)) {
        matches.set(candidate.id, candidate);
      }
    }
    matches.delete(item.id);
    related.set(item.id, {
      conversationIds: [...links].filter(
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
