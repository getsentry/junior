import type { Destination, Source } from "@sentry/junior-plugin-api";
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
    actorIdentityId: text("actor_identity_id")
      .notNull()
      .references(() => juniorIdentities.id),
    // Where the input came from. Core stores it and does not read it.
    source: jsonb("source").$type<Source>().notNull(),
    // The host's grouping of inputs: an input joins only a Turn whose inputs
    // have the same key. Core compares it and never reads its parts.
    groupKey: text("group_key").notNull(),
    // Where the answer to the input goes, set by the code that sent it. Null
    // when the Conversation history is the only answer, as for the dashboard.
    destination: jsonb("destination").$type<Destination>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // The same key on every delivery of the input. The Source gives it, for
    // example the Slack message id or the `idempotencyKey` a web client sends.
    idempotencyKey: text("idempotency_key").notNull(),
    // The trace of the source request, so the Turn that takes the input
    // continues it.
    traceContext: jsonb("trace_context").$type<TurnInputTraceContext>(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => juniorTurns.id),
    // The time the source gives for the input, such as a Slack message ts.
    sentAt: timestamptz("sent_at").notNull(),
    // Set when an attempt of the Turn first claims it with the input unread. A
    // failed Turn drops these inputs and moves only inputs that arrived after
    // its last claim. It does not mean read.
    attemptedAt: timestamptz("attempted_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_turn_inbox_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
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
