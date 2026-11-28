/**
 * The content of a question item. A question holds its own title, body,
 * request, and answer (`junior_questions`), and its Inbox item stores
 * none of them. Another kind keeps them on the item. A read that shows
 * that content left-joins the question with `itemQuestion` and selects
 * these expressions.
 */
import { and, eq, sql } from "drizzle-orm";
import { juniorInboxItems, juniorQuestions } from "@/db/schema";
import type {
  InboxItemNoticeRequest,
  InboxItemRequest,
} from "@/chat/questions/request";
import { INBOX_SUBJECT_KINDS } from "./subjects";

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
