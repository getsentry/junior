import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorReviewItemConversations, juniorReviewItems } from "@/db/schema";
import { reviewItemVisibleTo, type ReviewItemReader } from "./access";
import type { ReviewItem } from "./store";

// Each read scans at most this many candidate items for one page, and each
// item keeps at most `RELATED_ITEM_LIMIT` of them. The scan is newest
// first, so a busy subject drops its oldest items, not the page's items.
const RELATED_SCAN_LIMIT = 200;
const RELATED_ITEM_LIMIT = 10;

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
function linkedWork(item: ReviewItem): string[] {
  return item.conversationIds.filter((id) => id !== item.addedByConversationId);
}

function openVisible(reader: ReviewItemReader): SQL {
  return and(
    eq(juniorReviewItems.status, "open"),
    reviewItemVisibleTo(reader),
  )!;
}

const candidateColumns = {
  createdAt: juniorReviewItems.createdAt,
  id: juniorReviewItems.id,
  subjectId: juniorReviewItems.subjectId,
  subjectUrl: juniorReviewItems.subjectUrl,
  title: juniorReviewItems.title,
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
  reader: ReviewItemReader,
  viewer: User,
  items: readonly ReviewItem[],
): Promise<Map<string, RelatedReviewWork>> {
  const open = items.filter((item) => item.status === "open");
  const subjectIds = [
    ...new Set(open.flatMap((item) => item.subject?.id ?? [])),
  ];
  const subjectUrls = [
    ...new Set(open.flatMap((item) => item.subject?.url ?? [])),
  ];
  const linkIds = [...new Set(open.flatMap(linkedWork))];
  const [bySubject, byLink, access] = await Promise.all([
    subjectIds.length > 0 || subjectUrls.length > 0
      ? db
          .select(candidateColumns)
          .from(juniorReviewItems)
          .where(
            and(
              openVisible(reader),
              or(
                ...(subjectIds.length > 0
                  ? [inArray(juniorReviewItems.subjectId, subjectIds)]
                  : []),
                ...(subjectUrls.length > 0
                  ? [inArray(juniorReviewItems.subjectUrl, subjectUrls)]
                  : []),
              ),
            ),
          )
          .orderBy(
            desc(juniorReviewItems.createdAt),
            desc(juniorReviewItems.id),
          )
          .limit(RELATED_SCAN_LIMIT)
      : [],
    linkIds.length > 0
      ? db
          .select({
            ...candidateColumns,
            conversationId: juniorReviewItemConversations.conversationId,
          })
          .from(juniorReviewItemConversations)
          .innerJoin(
            juniorReviewItems,
            eq(juniorReviewItems.id, juniorReviewItemConversations.itemId),
          )
          .where(
            and(
              inArray(juniorReviewItemConversations.conversationId, linkIds),
              openVisible(reader),
            ),
          )
          .orderBy(
            desc(juniorReviewItems.createdAt),
            desc(juniorReviewItems.id),
          )
          .limit(RELATED_SCAN_LIMIT)
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
