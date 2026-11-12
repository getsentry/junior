import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";

/**
 * Match a user_message payload that a person sent as an instruction from a
 * chat surface. `junior_conversation_events_user_message_time_idx` has this
 * predicate, so a query with it can use the index and skip other events.
 */
export function isUserInstruction(payload: SQLWrapper): SQL {
  return sql`(${payload}->'provenance'->>'authority') = 'instruction' and (${payload}->'provenance'->'actor'->>'platform') in ('slack', 'local', 'web')`;
}

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
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_events_conversation_id_seq_pk",
      columns: [table.conversationId, table.seq],
    }),
    foreignKey({
      name: "junior_conversation_events_conversation_id_junior_conversations_conversation_id_fk",
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
    // The newest user instruction, for each listed Conversation. With the
    // provenance check in the predicate, a newest-first read stops at the
    // first entry. A filter on the scan instead made Postgres misestimate
    // the match rate and sort every user_message of the Conversation.
    index("junior_conversation_events_user_message_time_idx")
      .on(table.conversationId, table.createdAt, table.seq)
      .where(
        sql`${table.type} = 'user_message' and ${isUserInstruction(table.payload)}`,
      ),
    index("junior_conversation_events_message_search_idx")
      .using("gin", sql`to_tsvector('english', ${table.payload}->>'text')`)
      .where(sql`${table.type} = 'message'`),
    uniqueIndex("junior_conversation_events_idempotency_idx").on(
      table.conversationId,
      table.idempotencyKey,
    ),
  ],
);
