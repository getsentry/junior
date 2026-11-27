/**
 * The content of a question item. A question holds its own title, body,
 * request, and answer (`junior_questions`), and its Inbox item stores
 * none of them. Another kind keeps them on the item. A read that shows
 * that content left-joins the question with `itemQuestion` and selects
 * these expressions.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { juniorInboxItems, juniorQuestions } from "@/db/schema";
import type { InboxItemNoticeRequest, InboxItemRequest } from "./request";
import { INBOX_SUBJECT_KINDS } from "./subjects";
import type { UserInputAnswer } from "./user-input-request";

/** SQL: the join of a question item to its question. */
export const itemQuestion = and(
  eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.question),
  eq(juniorQuestions.id, juniorInboxItems.subjectId),
)!;

/** SQL: the title of an item, from its question when it has one. */
export const inboxItemTitle = sql<string>`coalesce(${juniorQuestions.title}, ${juniorInboxItems.title}, '')`;

/** SQL: the body of an item, from its question when it has one. */
export const inboxItemBody = sql<string>`coalesce(${juniorQuestions.body}, ${juniorInboxItems.body}, '')`;

/** SQL: the request of an item, from its question when it has one. */
export const inboxItemRequest = sql<
  InboxItemRequest | InboxItemNoticeRequest | null
>`coalesce(${juniorQuestions.request}, ${juniorInboxItems.request})`;

// A question holds its own answer, who gave it, and when. Another kind
// keeps its answer on the item, and its close says who and when.
function answerColumn(question: AnyPgColumn, item: AnyPgColumn): SQL {
  return sql`case when ${juniorQuestions.id} is null then ${item} else ${question} end`;
}

/** SQL: the answer of an item, from its question when it has one. */
export const inboxItemAnswer = sql<UserInputAnswer | null>`${answerColumn(juniorQuestions.answer, juniorInboxItems.answer)}`;

/** SQL: the User who answered an item, from its question when it has one. */
export const inboxItemAnsweredByUserId = sql<
  string | null
>`${answerColumn(juniorQuestions.answeredByUserId, juniorInboxItems.closedByUserId)}`;

/** SQL: when an item was answered, from its question when it has one. */
export const inboxItemAnsweredAt = sql<Date | null>`${answerColumn(juniorQuestions.answeredAt, juniorInboxItems.closedAt)}`;
