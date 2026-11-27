import { sql, type SQL } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  InboxItemNoticeRequest,
  InboxItemRequest,
} from "@/chat/inbox-items/request";
import type { UserInputAnswer } from "@/chat/inbox-items/user-input-request";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

/**
 * The words of a question for search: its title, ranked above its body.
 * The `simple` config keeps each word as typed, so a prefix of it matches.
 */
export function questionSearchDocument(table: {
  body: AnyPgColumn;
  title: AnyPgColumn;
}): SQL {
  return sql`(setweight(to_tsvector('simple', ${table.title}), 'A') || setweight(to_tsvector('simple', ${table.body}), 'B'))`;
}

/** The lowercase title of a question, for typo-tolerant search. */
export function questionFuzzyTitle(table: { title: AnyPgColumn }): SQL {
  return sql`lower(${table.title})`;
}

/**
 * SQL: the question waits for an answer. It asks something, which a notice
 * does not, and it is not closed. Its Conversation needs input, the same for
 * every viewer. `junior_questions_waiting_idx` has this predicate.
 */
export function questionWaits(table: {
  closedAt: AnyPgColumn;
  request: AnyPgColumn;
}): SQL {
  return sql`(${table.closedAt} is null and ${table.request} ? 'question')`;
}

/**
 * One question or notice that an agent gave a person in a Conversation. It
 * belongs to that Conversation and holds its title, body, request (the form
 * and the related links), and its answer, who gave it, and when. Its Inbox
 * item has the subject `{ kind: "question", id }` and keeps only its own
 * open, done, or dismissed state.
 */
export const juniorQuestions = pgTable(
  "junior_questions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    /** The Turn that asked it, or last asked it again. */
    turnId: text("turn_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    request: jsonb("request").$type<
      InboxItemRequest | InboxItemNoticeRequest
    >(),
    answer: jsonb("answer").$type<UserInputAnswer>(),
    answeredByUserId: text("answered_by_user_id").references(
      () => juniorUsers.id,
      { onDelete: "set null" },
    ),
    answeredAt: timestamptz("answered_at"),
    /** When its Inbox item closed: answered, done, or dismissed. */
    closedAt: timestamptz("closed_at"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("junior_questions_conversation_idx").on(table.conversationId),
    index("junior_questions_waiting_idx")
      .on(table.conversationId)
      .where(questionWaits(table)),
    index("junior_questions_search_idx").using(
      "gin",
      questionSearchDocument(table),
    ),
    index("junior_questions_title_trgm_idx").using(
      "gin",
      sql`${questionFuzzyTitle(table)} gin_trgm_ops`,
    ),
  ],
);
