import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias, union, type AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  juniorCodeChanges,
  juniorInboxItems,
  juniorQuestions,
} from "@/db/schema";
import { codeChangeSearchDocument } from "@/db/schema/code";
import {
  inboxItemFuzzyTitle,
  inboxItemSearchDocument,
} from "@/db/schema/inbox-items";
import {
  questionFuzzyTitle,
  questionSearchDocument,
} from "@/db/schema/questions";
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
import { codeChangeSubjectKinds } from "./subject-links";
import { INBOX_SUBJECT_KINDS } from "./subjects";

/** An Inbox item that matches a search. */
export type InboxItemSearchMatch = Pick<
  typeof juniorInboxItems.$inferSelect,
  "id" | "status"
> & { title: string };

// The code change of an item subject: the kind's plugin is its provider, and
// the subject id is its provider id.
function subjectCodeChange(
  item: { subjectId: AnyPgColumn; subjectKind: AnyPgColumn },
  change: { provider: AnyPgColumn; providerId: AnyPgColumn },
): SQL {
  return and(
    eq(change.providerId, item.subjectId),
    eq(change.provider, sql`split_part(${item.subjectKind}, ':', 1)`),
  )!;
}

// The question of a question item.
function subjectQuestion(
  item: { subjectId: AnyPgColumn; subjectKind: AnyPgColumn },
  question: { id: AnyPgColumn },
): SQL {
  return and(
    eq(item.subjectKind, INBOX_SUBJECT_KINDS.question),
    eq(question.id, item.subjectId),
  )!;
}

/**
 * Find the items of the viewer's own Inbox, open and closed, as the Inbox
 * shows them. A word of the title or body starts with each word of the
 * query, or the title is close to the query despite a typo. A question
 * item matches on its question's title and body. An item whose subject is
 * a code change also matches on the code change's title. Open items come
 * first, each group best match first. Reads the GIN indexes
 * `junior_inbox_items_search_idx`, `junior_inbox_items_title_trgm_idx`,
 * `junior_questions_search_idx`, `junior_questions_title_trgm_idx`, and
 * `junior_code_changes_search_idx`.
 */
export async function searchInboxItemsForUser(
  viewer: User,
  query: TypedQuery,
  limit: number,
): Promise<InboxItemSearchMatch[]> {
  const db = getDb();
  const items = juniorInboxItems;
  const visible = and(
    inboxItemVisibleTo(inboxItemReaderForUser(viewer)),
    inboxItemForUser(viewer.id),
  );
  // The newest matches, before any is ranked.
  const ownMatches = db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        or(
          prefixMatch(inboxItemSearchDocument(items), query),
          fuzzyMatch(inboxItemFuzzyTitle(items), query),
        ),
        visible,
      ),
    )
    .orderBy(desc(items.updatedAt), desc(items.id))
    .limit(SEARCH_RANK_WINDOW);
  const questionMatches = db
    .select({ id: items.id })
    .from(juniorQuestions)
    .innerJoin(items, subjectQuestion(items, juniorQuestions))
    .where(
      and(
        or(
          prefixMatch(questionSearchDocument(juniorQuestions), query),
          fuzzyMatch(questionFuzzyTitle(juniorQuestions), query),
        ),
        visible,
      ),
    )
    .orderBy(desc(items.updatedAt), desc(items.id))
    .limit(SEARCH_RANK_WINDOW);
  // Each code change kind searches its objects through the code change
  // index, so a pull request title finds its item, and the item stores no
  // copy of the title.
  const kinds = codeChangeSubjectKinds();
  const subjectMatches = db
    .select({ id: items.id })
    .from(juniorCodeChanges)
    .innerJoin(items, subjectCodeChange(items, juniorCodeChanges))
    .where(
      and(
        prefixMatch(codeChangeSearchDocument(juniorCodeChanges), query),
        inArray(items.subjectKind, kinds),
        visible,
      ),
    )
    .orderBy(desc(items.updatedAt), desc(items.id))
    .limit(SEARCH_RANK_WINDOW);
  const candidates = (
    kinds.length
      ? union(ownMatches, questionMatches, subjectMatches)
      : union(ownMatches, questionMatches)
  ).as("inbox_item_candidates");
  const item = alias(juniorInboxItems, "inbox_item");
  const question = alias(juniorQuestions, "inbox_item_question");
  const change = alias(juniorCodeChanges, "inbox_item_change");
  // A question item has no text of its own, so its question's text counts.
  const document = sql`coalesce(${questionSearchDocument(question)}, ${inboxItemSearchDocument(item)})`;
  const changeDocument = codeChangeSearchDocument(change);
  const title = sql`coalesce(${questionFuzzyTitle(question)}, ${inboxItemFuzzyTitle(item)})`;
  const rows = await db
    .select({
      changeLexical: prefixRank(changeDocument, query),
      changeMatched: prefixMatch(changeDocument, query),
      fuzzy: fuzzyRank(title, query),
      fuzzyMatched: fuzzyMatch(title, query),
      id: item.id,
      lexical: prefixRank(document, query),
      lexicalMatched: prefixMatch(document, query),
      status: item.status,
      title: sql<string>`coalesce(${question.title}, ${item.title}, '')`,
      updatedAt: item.updatedAt,
    })
    .from(candidates)
    .innerJoin(item, eq(item.id, candidates.id))
    .leftJoin(question, subjectQuestion(item, question))
    .leftJoin(
      change,
      and(
        subjectCodeChange(item, change),
        kinds.length ? inArray(item.subjectKind, kinds) : sql`false`,
      ),
    );
  const ranked = rankSearchMatches(
    scoredSearchMatches(rows, {
      fuzzy: (row) => (row.fuzzyMatched ? Number(row.fuzzy) : undefined),
      // The better of the item's own text and its code change's title.
      lexical: (row) => {
        const own = row.lexicalMatched ? Number(row.lexical) : undefined;
        const subject = row.changeMatched
          ? Number(row.changeLexical)
          : undefined;
        return own === undefined || subject === undefined
          ? (own ?? subject)
          : Math.max(own, subject);
      },
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
