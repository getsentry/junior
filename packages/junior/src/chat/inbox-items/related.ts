import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItemConversations, juniorInboxItems } from "@/db/schema";
import { inboxItemVisibleTo, type InboxItemReader } from "./access";
import { ownerConversationId, type InboxItem } from "./store";
import { INBOX_SUBJECT_KINDS, subjectKindPlugin } from "./subjects";

// Each item keeps at most this many related items, newest first.
const RELATED_ITEM_LIMIT = 10;
// The reads keep this many of the newest candidates for each subject id
// and linked Conversation, so a busy subject cannot crowd out
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
  subjectId: string;
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
  title: juniorInboxItems.title,
};

/**
 * The subject id that related work matches: an outside object that an agent
 * or a plugin named, such as a release or a pull request. A core kind, and
 * an agent item that named no subject (its id is its dedupe key), relate to
 * nothing by subject.
 */
function relatedSubjectId(item: InboxItem): string | undefined {
  const { id, kind } = item.subject;
  if (kind === INBOX_SUBJECT_KINDS.agent) {
    return id === item.dedupeKey ? undefined : id;
  }
  return subjectKindPlugin(kind) ? id : undefined;
}

/**
 * Read the related work of each open item in a page: the other open items
 * that the reader can see with the same subject id, of any kind, or linked to one
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
    ...new Set(open.flatMap((item) => relatedSubjectId(item) ?? [])),
  ];
  const linkIds = [...new Set(open.flatMap(linkedWork))];
  const subjectRanks = db
    .select({
      ...candidateColumns,
      idRank: newestInGroup(juniorInboxItems.subjectId).as("id_rank"),
    })
    .from(juniorInboxItems)
    .where(
      and(openVisible(reader), inArray(juniorInboxItems.subjectId, subjectIds)),
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
    subjectIds.length > 0
      ? db
          .select({
            createdAt: subjectRanks.createdAt,
            id: subjectRanks.id,
            subjectId: subjectRanks.subjectId,
            title: subjectRanks.title,
          })
          .from(subjectRanks)
          .where(lte(subjectRanks.idRank, RELATED_CANDIDATE_LIMIT))
      : [],
    linkIds.length > 0
      ? db
          .select({
            conversationId: linkRanks.conversationId,
            createdAt: linkRanks.createdAt,
            id: linkRanks.id,
            subjectId: linkRanks.subjectId,
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
    const subjectId = relatedSubjectId(item);
    for (const candidate of bySubject) {
      if (subjectId && candidate.subjectId === subjectId) {
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
