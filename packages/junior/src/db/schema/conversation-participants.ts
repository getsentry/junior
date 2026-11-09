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
 * input messages. Thread context authors do not get a row. An unsubscribed
 * row keeps access but leaves the active feed.
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
    // Archive moved to `junior_conversations.archived_at`. Runtime code must
    // not read or write this column. A later migration drops it.
    legacyArchivedAt: timestamptz("archived_at"),
    pinnedAt: timestamptz("pinned_at"),
    /**
     * The viewer's place for this pin in the Pinned section, from a drag
     * reorder. Null until the first reorder, and cleared on unpin and
     * re-pin. Null pins sort first, by activity.
     */
    pinPosition: integer("pin_position"),
    /**
     * Per-conversation auto-archive choice for this user. Null uses the
     * user's `autoArchiveDefault`.
     */
    autoArchive: boolean("auto_archive"),
    /**
     * Set when this user left the conversation. It stays out of their
     * active feed until they mention Junior in it again, subscribe, or pin
     * it. The row keeps its access, so it is not deleted.
     */
    unsubscribedAt: timestamptz("unsubscribed_at"),
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
      .where(sql`${table.autoArchive}`),
    // The active feed excludes a person's unsubscribed roots with an
    // anti-join. Few rows are unsubscribed, so this index stays small.
    index("junior_conversation_participants_unsubscribed_idx")
      .on(table.userId, table.rootConversationId)
      .where(sql`${table.unsubscribedAt} is not null`),
  ],
);
