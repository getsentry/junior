import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { juniorIdentities } from "./identities";
import { juniorReviewItems } from "./review-items";
import type { EventAutomationRecord } from "@/chat/event-automations/types";
import type { ScheduledAutomationRecord } from "@/chat/scheduled-automations/types";
import type { WakeAutomationRecord } from "@/chat/wake-automations/types";

/**
 * One row per Automation of either kind. `record` holds the fields that have
 * no column. Each write also copies the nested fields that queries filter or
 * search on into columns: `team_id`, `channel_id`, `creator_slack_user_id`,
 * the task `instruction` or `skill`, and the event trigger `namespace` and
 * `identifier`. Exactly one of `instruction` and `skill` is set, by the task
 * kind. A skill's context is only in `record`. An event trigger with no
 * identifier runs for every resource of its namespace, so its `identifier` is
 * null. The match index finds those rows with `identifier is null`.
 *
 * `action` is `run` for an Automation that starts a Turn, and `wake` for a
 * Snooze: a one-shot Automation that brings an Inbox row back and runs no
 * Turn. A run row has a Slack Destination in its three Slack columns. A wake
 * row has none; it has a subject instead, and its owner reads it on the
 * dashboard. A wake row keeps its Event trigger in `namespace` and
 * `identifier`, like an event row, and its timer fire time in
 * `next_run_at_ms`. Its `kind` is `event` when it has an Event trigger, else
 * `scheduled`.
 */
export const juniorAutomations = pgTable(
  "junior_automations",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"scheduled" | "event">().notNull(),
    action: text("action").$type<"run" | "wake">().notNull().default("run"),
    /** Null only for a wake row, which has no Slack Destination. */
    teamId: text("team_id"),
    /** Null only for a wake row. */
    channelId: text("channel_id"),
    /** Null only for a wake row. */
    creatorSlackUserId: text("creator_slack_user_id"),
    /** The Conversation whose Inbox row a wake row hides. */
    subjectConversationId: text("subject_conversation_id"),
    /**
     * The one Review item whose Inbox row a wake row hides. Null when the
     * wake hides every item of its subject Conversation.
     */
    subjectReviewItemId: text("subject_review_item_id"),
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
    namespace: text("namespace"),
    identifier: text("identifier"),
    record: jsonb("record")
      .$type<
        ScheduledAutomationRecord | EventAutomationRecord | WakeAutomationRecord
      >()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_automations_subject_conversation_fk",
      columns: [table.subjectConversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "junior_automations_subject_review_item_fk",
      columns: [table.subjectReviewItemId],
      foreignColumns: [juniorReviewItems.id],
    }).onDelete("cascade"),
    check(
      "junior_automations_kind_check",
      sql`${table.kind} in ('scheduled', 'event')`,
    ),
    check(
      "junior_automations_status_check",
      sql`${table.status} in ('active', 'blocked', 'paused', 'completed', 'deleted')`,
    ),
    check(
      "junior_automations_action_check",
      sql`${table.action} in ('run', 'wake')`,
    ),
    check(
      "junior_automations_task_check",
      sql`(${table.action} = 'wake' and ${table.instruction} is null and ${table.skill} is null) or (${table.action} = 'run' and (${table.instruction} is null) <> (${table.skill} is null))`,
    ),
    check(
      "junior_automations_destination_check",
      sql`(${table.action} = 'run' and ${table.teamId} is not null and ${table.channelId} is not null and ${table.creatorSlackUserId} is not null and ${table.subjectConversationId} is null and ${table.subjectReviewItemId} is null) or (${table.action} = 'wake' and ${table.teamId} is null and ${table.channelId} is null and ${table.creatorSlackUserId} is null and ${table.subjectConversationId} is not null)`,
    ),
    check(
      "junior_automations_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
    check(
      "junior_automations_trigger_check",
      sql`(${table.kind} = 'scheduled' and ${table.namespace} is null and ${table.identifier} is null) or (${table.kind} = 'event' and ${table.namespace} is not null and ${table.runNowAtMs} is null and (${table.action} = 'wake' or (${table.nextRunAtMs} is null and ${table.status} <> 'completed')))`,
    ),
    index("junior_automations_team_idx")
      .on(table.teamId, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
    index("junior_automations_creator_identity_idx").on(
      table.creatorIdentityId,
      table.createdAtMs,
      table.id,
    ),
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
    index("junior_automations_wake_subject_idx")
      .on(table.subjectConversationId, table.subjectReviewItemId)
      .where(sql`${table.status} = 'active' AND ${table.action} = 'wake'`),
    // One active Snooze per creator and Inbox row. A new Snooze replaces it.
    uniqueIndex("junior_automations_one_wake_idx")
      .on(
        table.creatorIdentityId,
        table.subjectConversationId,
        sql`coalesce(${table.subjectReviewItemId}, '')`,
      )
      .where(sql`${table.status} = 'active' AND ${table.action} = 'wake'`),
    index("junior_automations_match_idx")
      .on(table.namespace, table.identifier, table.createdAtMs, table.id)
      .where(sql`${table.status} <> 'deleted'`),
  ],
);
