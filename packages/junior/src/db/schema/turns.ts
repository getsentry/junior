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
