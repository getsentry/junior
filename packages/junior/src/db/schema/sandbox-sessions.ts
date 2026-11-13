import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * One Sandbox VM session and the Run that opened it. The provider reports
 * session usage only after the session stops, so a later sweep reads it and
 * writes the cost to the Run's `sandbox_cost_usd` metric.
 */
export const juniorSandboxSessions = pgTable(
  "junior_sandbox_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    // The Run created the Sandbox in this session, so the session also pays
    // for the creation.
    createdSandbox: boolean("created_sandbox").notNull(),
    // Null until the cost is known, and when the usage could not be read.
    costUsd: doublePrecision("cost_usd"),
    checkAfter: timestamptz("check_after").notNull(),
    settledAt: timestamptz("settled_at"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_sandbox_sessions_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }),
    index("junior_sandbox_sessions_conversation_run_idx").on(
      table.conversationId,
      table.runId,
    ),
    index("junior_sandbox_sessions_unsettled_check_after_idx")
      .on(table.checkAfter)
      .where(sql`${table.settledAt} is null`),
  ],
);
