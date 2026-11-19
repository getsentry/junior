import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";
import { juniorTurns } from "./turns";

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
    // The trace of the source request, so the Turn that takes the input
    // continues it.
    traceContext: jsonb("trace_context").$type<{
      sentryTrace: string;
      baggage?: string;
    }>(),
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
