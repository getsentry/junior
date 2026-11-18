import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Location } from "@/chat/conversations/location";
import { juniorConversationEvents } from "./conversation-events";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";

/**
 * One row per Turn: its state and the lease of the invocation that runs its
 * current step. A lease covers one step, not the whole Turn. `lease_epoch`
 * goes up on every claim and cancel, so a worker that lost the lease cannot
 * commit.
 */
export const juniorTurns = pgTable(
  "junior_turns",
  {
    id: uuid("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    actorIdentityId: text("actor_identity_id")
      .notNull()
      .references(() => juniorIdentities.id),
    state: text("state")
      .$type<"queued" | "running" | "completed" | "failed" | "cancelled">()
      .notNull(),
    stepSeq: integer("step_seq").default(0).notNull(),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    attempts: integer("attempts").default(0).notNull(),
    endReason: text("end_reason"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    endedAt: timestamptz("ended_at"),
  },
  (table) => [
    foreignKey({
      name: "junior_turns_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    check(
      "junior_turns_state_check",
      sql`${table.state} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    // A lease exists exactly while a step runs.
    check(
      "junior_turns_lease_check",
      sql`(${table.state} = 'running') = (${table.leaseOwner} is not null) and (${table.state} = 'running') = (${table.leaseExpiresAt} is not null)`,
    ),
    check(
      "junior_turns_ended_check",
      sql`(${table.state} in ('completed', 'failed', 'cancelled')) = (${table.endedAt} is not null)`,
    ),
    check(
      "junior_turns_counters_check",
      sql`${table.stepSeq} >= 0 and ${table.leaseEpoch} >= 0 and ${table.attempts} >= 0`,
    ),
    // At most one active Turn per Conversation.
    uniqueIndex("junior_turns_active_conversation_idx")
      .on(table.conversationId)
      .where(sql`${table.state} in ('queued', 'running')`),
    // Sweeper: steps whose invocation died.
    index("junior_turns_running_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'running'`),
    // Sweeper: queued Turns whose queue message was lost.
    index("junior_turns_queued_updated_idx")
      .on(table.updatedAt)
      .where(sql`${table.state} = 'queued'`),
  ],
);

/**
 * Inputs for a Conversation. A row is pending until a model step writes it
 * into history and sets `turn_id` in the same transaction.
 */
export const juniorTurnInbox = pgTable(
  "junior_turn_inbox",
  {
    id: uuid("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").$type<"message" | "account_connected">().notNull(),
    actorIdentityId: text("actor_identity_id")
      .notNull()
      .references(() => juniorIdentities.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // The source's id for the input, such as a Slack event id.
    idempotencyKey: text("idempotency_key").notNull(),
    turnId: uuid("turn_id").references(() => juniorTurns.id),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_turn_inbox_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    check(
      "junior_turn_inbox_kind_check",
      sql`${table.kind} in ('message', 'account_connected')`,
    ),
    check(
      "junior_turn_inbox_payload_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    uniqueIndex("junior_turn_inbox_idempotency_idx").on(
      table.conversationId,
      table.idempotencyKey,
    ),
    index("junior_turn_inbox_pending_idx")
      .on(table.conversationId, table.createdAt)
      .where(sql`${table.turnId} is null`),
  ],
);

/**
 * One row per message to deliver to the Location. The content stays in the
 * message event; the row only tracks delivery.
 */
export const juniorTurnOutbox = pgTable(
  "junior_turn_outbox",
  {
    id: uuid("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => juniorTurns.id),
    eventSeq: integer("event_seq").notNull(),
    // Copied when the row is made, so a later Location change does not move
    // a pending delivery.
    location: jsonb("location").$type<Location>().notNull(),
    state: text("state").$type<"pending" | "sent" | "failed">().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    sentAt: timestamptz("sent_at"),
  },
  (table) => [
    // Retention purges events, which removes their delivery rows.
    foreignKey({
      name: "junior_turn_outbox_event_fk",
      columns: [table.conversationId, table.eventSeq],
      foreignColumns: [
        juniorConversationEvents.conversationId,
        juniorConversationEvents.seq,
      ],
    }).onDelete("cascade"),
    check(
      "junior_turn_outbox_state_check",
      sql`${table.state} in ('pending', 'sent', 'failed')`,
    ),
    check(
      "junior_turn_outbox_sent_check",
      sql`(${table.state} = 'sent') = (${table.sentAt} is not null)`,
    ),
    check("junior_turn_outbox_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "junior_turn_outbox_location_check",
      sql`jsonb_typeof(${table.location}) = 'object'`,
    ),
    uniqueIndex("junior_turn_outbox_event_idx").on(
      table.conversationId,
      table.eventSeq,
    ),
    // Sweeper: rows whose queue message was lost.
    index("junior_turn_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'pending'`),
  ],
);
