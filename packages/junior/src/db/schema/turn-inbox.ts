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

/** What an input is. */
export type TurnInputKind = "message" | "account_connected";

/** The trace of the source request that sent an input. */
export type TurnInputTraceContext = { sentryTrace: string; baggage?: string };

/**
 * Inputs for a Conversation. The scheduler sets `turn_id` when the row
 * arrives. A row is read when the Conversation's history has an event with
 * the `idempotency_key` `inbox:<row id>`.
 */
export const juniorTurnInbox = pgTable(
  "junior_turn_inbox",
  {
    id: uuid("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").$type<TurnInputKind>().notNull(),
    actorIdentityId: text("actor_identity_id")
      .notNull()
      .references(() => juniorIdentities.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // The source's id for the input, such as a Slack event id.
    idempotencyKey: text("idempotency_key").notNull(),
    // The trace of the source request, so the Turn that takes the input
    // continues it.
    traceContext: jsonb("trace_context").$type<TurnInputTraceContext>(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => juniorTurns.id),
    // The time the source gives for the input, such as a Slack message ts.
    sentAt: timestamptz("sent_at").notNull(),
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
    // The inputs of a Turn, in order.
    index("junior_turn_inbox_turn_idx").on(table.turnId, table.createdAt),
  ],
);
