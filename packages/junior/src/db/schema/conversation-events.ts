import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { juniorTurns } from "./turns";
import { timestamptz } from "./timestamps";

/**
 * Append-only canonical conversation history. `history_version` partitions
 * model-history replacements, while `(conversation_id, seq)` is the stable
 * event identity and lease-fencing tripwire.
 *
 * `actor_identity_id` is the first-class author identity for human-authored
 * events. Message payloads may still carry display author fields in `meta`.
 */
export const juniorConversationEvents = pgTable(
  "junior_conversation_events",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    historyVersion: integer("history_version").notNull(),
    schemaVersion: integer("schema_version").default(1).notNull(),
    idempotencyKey: text("idempotency_key"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    actorIdentityId: text("actor_identity_id").references(
      () => juniorIdentities.id,
    ),
    // The Turn that wrote the row, such as a step's agent history. Null for a
    // row that no Turn wrote, such as a person's message: an input can move
    // to another Turn, so its Turn is in `junior_turn_inbox`.
    turnId: uuid("turn_id").references(() => juniorTurns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_events_conversation_id_seq_pk",
      columns: [table.conversationId, table.seq],
    }),
    foreignKey({
      name: "junior_conversation_events_conversation_id_junior_conversations",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }),
    index("junior_conversation_events_history_version_idx").on(
      table.conversationId,
      table.historyVersion,
      table.seq,
    ),
    index("junior_conversation_events_type_idx").on(
      table.conversationId,
      table.type,
      table.seq,
    ),
    index("junior_conversation_events_plugin_report_idx")
      .on(
        sql`(${table.payload}->>'namespace')`,
        sql`(${table.payload}->>'name')`,
        table.createdAt,
      )
      .where(sql`${table.type} = 'structured_event'`),
    // Guardian review counts over a time window, across all Conversations.
    index("junior_conversation_events_guardian_review_time_idx")
      .on(table.createdAt)
      .where(sql`${table.type} = 'guardian_action_reviewed'`),
    // Recent authorization requests of one Conversation. Few events are
    // requests, so a Conversation with none reads one small index page.
    index("junior_conversation_events_authorization_request_idx")
      .on(table.conversationId, table.createdAt)
      .where(sql`${table.type} = 'authorization_requested'`),
    // Reads of one plugin event in one Conversation. Postgres ignores the
    // statistics of partial expression indexes, so without this index it
    // reads the plugin_report_idx rows of every Conversation.
    index("junior_conversation_events_plugin_conversation_idx")
      .on(
        table.conversationId,
        sql`(${table.payload}->>'namespace')`,
        sql`(${table.payload}->>'name')`,
        table.seq,
      )
      .where(sql`${table.type} = 'structured_event'`),
    index("junior_conversation_events_actor_identity_idx").on(
      table.actorIdentityId,
      table.conversationId,
      table.seq,
    ),
    // The rows of one Turn, and the delete of a Turn, which sets them null.
    index("junior_conversation_events_turn_idx")
      .on(table.turnId, table.seq)
      .where(sql`${table.turnId} is not null`),
    // Message authors of a set of Conversations. The dashboard reads them for
    // each Conversation list and detail request.
    index("junior_conversation_events_author_idx")
      .on(table.conversationId, table.actorIdentityId, table.seq)
      .where(sql`${table.actorIdentityId} is not null`),
    // The newest Message with one role, for each listed Conversation. With
    // the role in the index, a newest-first read stops at the first match.
    // The index also gives Postgres statistics on the role.
    index("junior_conversation_events_message_role_idx")
      .on(
        table.conversationId,
        sql`(${table.payload}->>'role')`,
        table.createdAt,
        table.seq,
      )
      .where(sql`${table.type} = 'message'`),
    // The newest Message with one role in transcript order, for status.
    // A newest-first read stops at the first entry; in message_role_idx
    // `created_at` comes before `seq`, so that read sorts every Message of
    // the role.
    index("junior_conversation_events_message_role_seq_idx")
      .on(table.conversationId, sql`(${table.payload}->>'role')`, table.seq)
      .where(sql`${table.type} = 'message'`),
    index("junior_conversation_events_message_search_idx")
      .using("gin", sql`to_tsvector('english', ${table.payload}->>'text')`)
      .where(sql`${table.type} = 'message'`),
    uniqueIndex("junior_conversation_events_idempotency_idx").on(
      table.conversationId,
      table.idempotencyKey,
    ),
  ],
);
