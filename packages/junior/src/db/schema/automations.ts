import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import type { EventAutomationRecord } from "@/chat/event-automations/types";
import type { ScheduledAutomationRecord } from "@/chat/scheduled-automations/types";

export type AutomationKind = "scheduled" | "event";

export type AutomationStatus =
  | "active"
  | "blocked"
  | "paused"
  | "completed"
  | "deleted";

/**
 * One row per Automation of either kind. Top-level scalar fields have their
 * own columns, and `record` holds the rest of the Automation. The kind store
 * also copies nested values that queries filter, join, or search on into
 * columns, on every write: `team_id`, `channel_id`, `creator_slack_user_id`,
 * `instruction`, and the Event trigger `namespace` and `identifier`.
 */
export const juniorAutomations = pgTable(
  "junior_automations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<AutomationKind>().notNull(),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    creatorSlackUserId: text("creator_slack_user_id").notNull(),
    /** Provider identity that created a Scheduled automation. */
    creatorIdentityId: text("creator_identity_id"),
    status: text("status").$type<AutomationStatus>().notNull(),
    /** Why a run blocked this Automation, until its creator resumes it. */
    statusReason: text("status_reason"),
    title: text("title"),
    instruction: text("instruction").notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    nextRunAtMs: bigint("next_run_at_ms", { mode: "number" }),
    runNowAtMs: bigint("run_now_at_ms", { mode: "number" }),
    namespace: text("namespace"),
    identifier: text("identifier"),
    record: jsonb("record")
      .$type<ScheduledAutomationRecord | EventAutomationRecord>()
      .notNull(),
  },
  (table) => [
    check(
      "junior_automations_kind_check",
      sql`${table.kind} in ('scheduled', 'event')`,
    ),
    check(
      "junior_automations_status_check",
      sql`${table.status} in ('active', 'blocked', 'paused', 'completed', 'deleted')`,
    ),
    check(
      "junior_automations_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
    check(
      "junior_automations_trigger_check",
      sql`(${table.kind} = 'scheduled' and ${table.namespace} is null and ${table.identifier} is null) or (${table.kind} = 'event' and ${table.namespace} is not null and ${table.identifier} is not null and ${table.nextRunAtMs} is null and ${table.runNowAtMs} is null and ${table.status} <> 'completed')`,
    ),
    index("junior_automations_team_idx")
      .on(table.teamId, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_automations_creator_idx").on(
      table.teamId,
      table.creatorSlackUserId,
      table.createdAtMs,
      table.id,
    ),
    index("junior_automations_creator_identity_idx")
      .on(table.creatorIdentityId, table.createdAtMs, table.id)
      .where(sql`${table.creatorIdentityId} IS NOT NULL`),
    index("junior_automations_run_now_due_idx")
      .on(table.runNowAtMs, table.createdAtMs, table.id)
      .where(
        sql`${table.status} = 'active' AND ${table.runNowAtMs} IS NOT NULL`,
      ),
    index("junior_automations_next_run_due_idx")
      .on(table.nextRunAtMs, table.createdAtMs, table.id)
      .where(
        sql`${table.status} = 'active' AND ${table.nextRunAtMs} IS NOT NULL`,
      ),
    index("junior_automations_match_idx")
      .on(table.namespace, table.identifier, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
  ],
);
