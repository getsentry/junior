import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
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
import type { Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
import type { AgentTurnUsage } from "@/chat/usage";
import type { ChildSpawnOptions } from "@/chat/agent-invocations/spawn-options";
import type {
  ConversationKind,
  ConversationSource,
  ConversationStatus,
} from "@/chat/conversations/store";

export const juniorConversations = pgTable(
  "junior_conversations",
  {
    conversationId: text("conversation_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    source: text("source").$type<ConversationSource>(),
    /** Structured session Source locator; set-once on the conversation root. */
    // TODO(dcramer): Remove source_json after resume reads the saved Turn Source
    // and all provider context readers use Conversation Location.
    sessionSource: jsonb("source_json").$type<SessionSource>(),
    /** Complete Location associated with this Conversation. */
    location: jsonb("location_json").$type<Location>(),
    // TODO(dcramer): Rename destination_id to location_id after all deployed
    // readers and writers use the singular Conversation Location contract.
    destinationId: text("destination_id").references(
      () => juniorDestinations.id,
    ),
    // TODO(dcramer): Drop destination_json after every row uses location_id and
    // no supported worker writes the legacy JSON value.
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
    /**
     * The newest Message that a reader would notice (`refreshLastMessageAt`).
     * Null until the Conversation has one.
     */
    lastMessageAt: timestamptz("last_message_at"),
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
    // `root` or `automation` exactly when parent_conversation_id is null. Set
    // once at create.
    // The checks below enforce this. A writer of an older deploy leaves it null.
    // TODO(dcramer): After every deployed writer sets kind, rerun the
    // `kind IS NULL` backfill, add NOT NULL, and drop the `kind is null or`
    // arm of junior_conversations_kind_parent_check.
    kind: text("kind").$type<ConversationKind>(),
    // The `spawnAgent` options that every Turn of a child agent keeps. Set
    // once at create. Agent invocation rows also hold them until #3060
    // step 7 drops the rows; readers read the row first.
    spawnOptions: jsonb("spawn_options_json").$type<ChildSpawnOptions>(),
    // Archive applies to everyone, on a root or a child. A Conversation shows
    // only while it and every ancestor are unarchived.
    archivedAt: timestamptz("archived_at"),
    // The old child archive, copied into `archived_at`. Runtime code must not
    // read or write it. A later migration drops it, so the release before
    // still reads it while it rolls out.
    legacyChildArchivedAt: timestamptz("child_archived_at"),
    // Forks are independent roots. This edge supports source/fork lookup and
    // does not affect root ownership or child conversation traversal.
    forkedFromConversationId: text("forked_from_conversation_id").references(
      (): AnyPgColumn => juniorConversations.conversationId,
      { onDelete: "set null" },
    ),
    // Set while a fork is a Quick question that nobody kept. Lists and search
    // hide it. Keep as fork clears it.
    quickQuestionAt: timestamptz("quick_question_at"),
    // Roots reference themselves; descendants reference the root whose actor
    // and destination own their privacy boundary.
    rootConversationId: text("root_conversation_id").references(
      (): AnyPgColumn => juniorConversations.conversationId,
    ),
    transcriptPurgedAt: timestamptz("transcript_purged_at"),
    /**
     * Set while the Conversation is stopped. Its Watch Events are then saved
     * as Messages that start no Turn. A person's later input, or new work
     * from its parent, clears it.
     */
    stoppedAt: timestamptz("stopped_at"),
    /**
     * Set while a root's Event Turn replies stay out of its Location. Junior
     * still stores them. A person's next mention in the Location clears it.
     */
    deliveryPausedAt: timestamptz("delivery_paused_at"),
    durationMs: integer("duration_ms").notNull().default(0),
    usage: jsonb("usage_json").$type<AgentTurnUsage>(),
    executionDurationMs: integer("execution_duration_ms").notNull().default(0),
    executionUsage: jsonb("execution_usage_json").$type<AgentTurnUsage>(),
    metricRunId: text("metric_run_id"),
    // Bumped by every write that changes this Conversation's detail report.
    // Detail reads compare it before they build the report. The
    // `junior/touch-conversation-detail` lint rule enforces the bump.
    detailVersion: integer("detail_version").notNull().default(0),
  },
  (table) => [
    check(
      "junior_conversations_kind_check",
      sql`${table.kind} in ('root', 'automation', 'thread', 'task')`,
    ),
    check(
      "junior_conversations_kind_parent_check",
      sql`${table.kind} is null or ((${table.kind} in ('root', 'automation')) = (${table.parentConversationId} is null))`,
    ),
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
    index("junior_conversations_parent_idx").on(table.parentConversationId),
    index("junior_conversations_forked_from_idx").on(
      table.forkedFromConversationId,
    ),
    index("junior_conversations_root_idx").on(table.rootConversationId),
  ],
);
