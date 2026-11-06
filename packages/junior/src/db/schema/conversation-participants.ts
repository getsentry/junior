import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * Materialized personal-feed membership for one linked user on one root
 * conversation. Rows come from the root actor and from the authors of Turn
 * input messages. Thread context authors do not get a row.
 */
export const juniorConversationParticipants = pgTable(
  "junior_conversation_participants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id),
    rootConversationId: text("root_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    lastMessageAt: timestamptz("last_message_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    pinnedAt: timestamptz("pinned_at"),
    /**
     * The viewer's place for this pin in the Pinned section, from a drag
     * reorder. Null until the first reorder, and cleared on unpin, re-pin,
     * and archive. Null pins sort first, by activity.
     */
    pinPosition: integer("pin_position"),
    /**
     * Per-conversation auto-archive choice for this user. Null uses the
     * user's `autoArchiveDefault`.
     */
    autoArchive: boolean("auto_archive"),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_participants_user_root_pk",
      columns: [table.userId, table.rootConversationId],
    }),
    index("junior_conversation_participants_user_activity_idx").on(
      table.userId,
      table.lastMessageAt.desc(),
    ),
    index("junior_conversation_participants_root_idx").on(
      table.rootConversationId,
    ),
    // The auto-archive sweep finds users who turned it on for one
    // conversation without reading every participant row.
    index("junior_conversation_participants_auto_archive_idx")
      .on(table.userId)
      .where(sql`${table.autoArchive} and ${table.archivedAt} is null`),
    // The auto-archive sweep pages one user's unarchived rows older than the
    // cutoff. Archived rows build up over time, so the index leaves them out.
    index("junior_conversation_participants_unarchived_activity_idx")
      .on(table.userId, table.lastMessageAt, table.rootConversationId)
      .where(sql`${table.archivedAt} is null`),
  ],
);
