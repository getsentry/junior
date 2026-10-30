import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { juniorAutomationVersions } from "./automation-versions";
import { juniorAutomations } from "./automations";
import { juniorConversations } from "./conversations";

/** Lifecycle of one Automation run. */
export type AutomationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

/**
 * One dispatch of an Automation, from claim or dispatch to its outcome. A
 * Scheduled automation run id is `<automation id>:<scheduled time>`. An event
 * automation run id is its dispatch id. Automation code sets
 * `conversation_id` when it dispatches the run. A run that was skipped, or
 * that failed before dispatch, has no Conversation.
 *
 * `automation_version` is the Automation version that the run dispatched. It
 * shows which instruction ran and who saved it after the definition changes.
 * It is null before dispatch, and when no saved version matched.
 */
export const juniorAutomationRuns = pgTable(
  "junior_automation_runs",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => juniorAutomations.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .unique()
      .references(() => juniorConversations.conversationId),
    status: text("status").$type<AutomationRunStatus>().notNull(),
    automationVersion: integer("automation_version"),
    // Only Scheduled automation runs set these four columns.
    scheduledForMs: bigint("scheduled_for_ms", { mode: "number" }),
    attempt: integer("attempt"),
    claimedAtMs: bigint("claimed_at_ms", { mode: "number" }),
    dispatchId: text("dispatch_id"),
    startedAtMs: bigint("started_at_ms", { mode: "number" }),
    completedAtMs: bigint("completed_at_ms", { mode: "number" }),
    errorMessage: text("error_message"),
    resultMessageTs: text("result_message_ts"),
  },
  (table) => [
    foreignKey({
      name: "junior_automation_runs_automation_version_fk",
      columns: [table.automationId, table.automationVersion],
      foreignColumns: [
        juniorAutomationVersions.automationId,
        juniorAutomationVersions.version,
      ],
    }),
    check(
      "junior_automation_runs_status_check",
      sql`${table.status} in ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped')`,
    ),
    index("junior_automation_runs_automation_idx").on(
      table.automationId,
      table.completedAtMs,
    ),
    index("junior_automation_runs_completed_idx").on(table.completedAtMs),
    index("junior_automation_runs_incomplete_idx")
      .on(table.automationId, table.scheduledForMs)
      .where(sql`${table.status} in ('pending', 'running')`),
  ],
);
