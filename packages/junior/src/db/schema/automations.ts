import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { juniorAutomationRuns } from "./automation-runs";
import { juniorIdentities } from "./identities";
import type { EventAutomationRecord } from "@/chat/event-automations/types";
import type { ScheduledAutomationRecord } from "@/chat/scheduled-automations/types";

/**
 * The words of an Automation for search: its title, ranked above its task
 * and, for an event Automation, its trigger. The `simple` config keeps each
 * word as typed, so a prefix of it matches.
 */
export function automationSearchDocument(table: {
  identifier: AnyPgColumn;
  instruction: AnyPgColumn;
  kind: AnyPgColumn;
  namespace: AnyPgColumn;
  record: AnyPgColumn;
  skill: AnyPgColumn;
  title: AnyPgColumn;
}): SQL {
  return sql`(setweight(to_tsvector('simple', coalesce(${table.title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${table.instruction}, '') || ' ' || coalesce(${table.skill}, '') || ' ' || case when ${table.kind} = 'event' then coalesce(${table.identifier}, '') || ' ' || coalesce(${table.record}->'trigger'->>'label', '') || ' ' || coalesce(${table.namespace}, '') else '' end), 'B'))`;
}

/** The lowercase title of an Automation, for typo-tolerant search. */
export function automationFuzzyTitle(table: { title: AnyPgColumn }): SQL {
  return sql`lower(coalesce(${table.title}, ''))`;
}

/**
 * One row per Automation of either kind. `record` holds the fields that have
 * no column. Each write also copies the nested fields that queries filter or
 * search on into columns: `team_id`, `channel_id`, `creator_slack_user_id`,
 * the task `instruction` or `skill`, and the event trigger `namespace` and
 * `identifier`. Exactly one of `instruction` and `skill` is set, by the task
 * kind. A skill's context is only in `record`. An event trigger with no
 * identifier runs for every resource of its namespace, so its `identifier` is
 * null. The match index finds those rows with `identifier is null`.
 */
export const juniorAutomations = pgTable(
  "junior_automations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"scheduled" | "event">().notNull(),
    teamId: text("team_id").notNull(),
    channelId: text("channel_id").notNull(),
    creatorSlackUserId: text("creator_slack_user_id").notNull(),
    /** Junior identity that created the Automation. It decides ownership. */
    creatorIdentityId: text("creator_identity_id")
      .notNull()
      .references(() => juniorIdentities.id),
    status: text("status")
      .$type<"active" | "blocked" | "paused" | "completed" | "deleted">()
      .notNull(),
    /** Why a run blocked this Automation, until its creator resumes it. */
    statusReason: text("status_reason"),
    title: text("title"),
    /** The instruction of an instruction task. Null for a skill task. */
    instruction: text("instruction"),
    /** The skill of a skill task. Null for an instruction task. */
    skill: text("skill"),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    nextRunAtMs: bigint("next_run_at_ms", { mode: "number" }),
    runNowAtMs: bigint("run_now_at_ms", { mode: "number" }),
    /**
     * The latest run with an outcome. The list reads its end time and status
     * to order by activity and to find failed last runs.
     * `refreshAutomationLastRun` sets it after each run write. A purged run
     * clears it.
     */
    lastRunId: text("last_run_id").references(
      (): AnyPgColumn => juniorAutomationRuns.id,
      { onDelete: "set null" },
    ),
    /**
     * When core last saw this Automation recover after a person dismissed
     * its alert. A dismissed alert hides the Automation's alerts until then.
     */
    alertRecoveredAtMs: bigint("alert_recovered_at_ms", { mode: "number" }),
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
      "junior_automations_task_check",
      sql`(${table.instruction} is null) <> (${table.skill} is null)`,
    ),
    check(
      "junior_automations_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
    check(
      "junior_automations_trigger_check",
      sql`(${table.kind} = 'scheduled' and ${table.namespace} is null and ${table.identifier} is null) or (${table.kind} = 'event' and ${table.namespace} is not null and ${table.nextRunAtMs} is null and ${table.runNowAtMs} is null and ${table.status} <> 'completed')`,
    ),
    index("junior_automations_team_idx")
      .on(table.teamId, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_automations_creator_identity_idx").on(
      table.creatorIdentityId,
      table.createdAtMs,
      table.id,
    ),
    // The other arm of the owned rule (`viewerAutomationCollection`): an
    // Automation that a viewer's Slack account created. With the identity
    // index, Mine reads only the viewer's rows.
    index("junior_automations_creator_slack_idx")
      .on(table.teamId, table.creatorSlackUserId)
      .where(sql`${table.status} <> 'deleted'`),
    // The activity page walks runs newest first and finds the Automation
    // whose last run each one is. A purged run clears `last_run_id` through it.
    index("junior_automations_last_run_idx").on(table.lastRunId),
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
    index("junior_automations_skill_idx")
      .on(table.skill, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted' AND ${table.skill} IS NOT NULL`),
    index("junior_automations_match_idx")
      .on(table.namespace, table.identifier, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_automations_search_idx")
      .using("gin", automationSearchDocument(table))
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_automations_title_trgm_idx")
      .using("gin", sql`${automationFuzzyTitle(table)} gin_trgm_ops`)
      .where(sql`${table.status} <> 'deleted'`),
  ],
);
