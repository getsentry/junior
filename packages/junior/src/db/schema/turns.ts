import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@/chat/conversations/history";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** The state of a Turn. */
export type TurnState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

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
    state: text("state").$type<TurnState>().notNull(),
    // Lower runs first. The scheduler sets it; core only sorts by it.
    priority: integer("priority").notNull(),
    stepSeq: integer("step_seq").default(0).notNull(),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    attempts: integer("attempts").default(0).notNull(),
    endReason: text("end_reason"),
    // Set only when the Turn fails, with main's failure labels: where it
    // stopped, the provider error kind of a failed model request, and the
    // Sentry event id of the failure.
    failureCode: text("failure_code").$type<ConversationTurnFailureCode>(),
    failureReason:
      text("failure_reason").$type<ConversationTurnFailureReason>(),
    failureEventId: text("failure_event_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    // Set by the first claim. A Turn that ends while queued never starts.
    startedAt: timestamptz("started_at"),
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
    check("junior_turns_priority_check", sql`${table.priority} >= 0`),
    // At most one running Turn per Conversation. More Turns can wait queued.
    uniqueIndex("junior_turns_running_conversation_idx")
      .on(table.conversationId)
      .where(sql`${table.state} = 'running'`),
    // The next queued Turn of a Conversation.
    index("junior_turns_queued_priority_idx")
      .on(table.conversationId, table.priority, table.createdAt)
      .where(sql`${table.state} = 'queued'`),
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
