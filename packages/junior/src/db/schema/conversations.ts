import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { juniorDestinations } from "./destinations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";
import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackActor } from "@/chat/actor";
import type { AgentTurnUsage } from "@/chat/usage";
import type {
  ConversationSource,
  ConversationStatus,
} from "@/chat/conversations/store";

export const juniorConversations = pgTable(
  "junior_conversations",
  {
    conversationId: text("conversation_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    source: text("source").$type<ConversationSource>(),
    originType: text("origin_type"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    destinationId: text("destination_id").references(
      () => juniorDestinations.id,
    ),
    destination: jsonb("destination_json").$type<Destination>(),
    actorIdentityId: text("actor_identity_id").references(
      () => juniorIdentities.id,
    ),
    creatorIdentityId: text("creator_identity_id").references(
      () => juniorIdentities.id,
    ),
    credentialSubjectIdentityId: text(
      "credential_subject_identity_id",
    ).references(() => juniorIdentities.id),
    actor: jsonb("actor_json").$type<StoredSlackActor>(),
    channelName: text("channel_name"),
    title: text("title"),
    createdAt: timestamptz("created_at").notNull(),
    lastActivityAt: timestamptz("last_activity_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    executionUpdatedAt: timestamptz("execution_updated_at"),
    executionStatus: text("execution_status")
      .$type<ConversationStatus>()
      .notNull(),
    runId: text("run_id"),
    lastCheckpointAt: timestamptz("last_checkpoint_at"),
    lastEnqueuedAt: timestamptz("last_enqueued_at"),
    // Subagent runs are child conversations; top-level listings filter
    // parent_conversation_id IS NULL. Historical advisor children use this too.
    parentConversationId: text("parent_conversation_id").references(
      (): AnyPgColumn => juniorConversations.conversationId,
    ),
    transcriptPurgedAt: timestamptz("transcript_purged_at"),
    durationMs: integer("duration_ms").notNull().default(0),
    usage: jsonb("usage_json").$type<AgentTurnUsage>(),
    executionDurationMs: integer("execution_duration_ms").notNull().default(0),
    executionUsage: jsonb("execution_usage_json").$type<AgentTurnUsage>(),
    metricRunId: text("metric_run_id"),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    index("junior_conversations_last_activity_idx").on(
      table.lastActivityAt.desc(),
      table.conversationId,
    ),
    index("junior_conversations_active_idx")
      .using(
        "btree",
        sql`coalesce(${table.executionUpdatedAt}, ${table.updatedAt})`,
        table.conversationId,
      )
      .where(sql`${table.executionStatus} <> 'idle'`),
    index("junior_conversations_destination_activity_idx").on(
      table.destinationId,
      table.lastActivityAt.desc(),
    ),
    index("junior_conversations_actor_activity_idx").on(
      table.actorIdentityId,
      table.lastActivityAt.desc(),
    ),
    index("junior_conversations_origin_idx").on(
      table.originType,
      table.originId,
      table.lastActivityAt.desc(),
    ),
    index("junior_conversations_parent_idx").on(table.parentConversationId),
  ],
);
