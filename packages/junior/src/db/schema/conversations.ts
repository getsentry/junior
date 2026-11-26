import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { juniorDestinations } from "./destinations";
import { juniorIdentities } from "./identities";
import { juniorSpaces } from "./spaces";
import { timestamptz } from "./timestamps";
import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackActor } from "@/chat/actor";
import type { Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
import type { AgentTurnUsage } from "@/chat/usage";
import type { AgentConfig } from "@/chat/conversations/agent-config";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
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
    // Conversation metadata, refreshed in the background after each Turn.
    // Search, lists, details, unfurls, and the Conversation embedding read it.
    summary: text("summary"),
    // The last event that `summary` covers. A Turn whose terminal event is
    // at or before it has nothing new to add.
    metadataThroughSeq: integer("metadata_through_seq"),
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
    // Set once at create. A `task` always has a parent, an `automation` or a
    // `lead` never does, and a `thread` may have one.
    // The checks below enforce this. A writer of an older deploy leaves it
    // null, or writes the retired `root`, which the
    // `junior_conversations_kind_root_to_thread` trigger stores as `thread`.
    // TODO(dcramer): After every deployed writer sets `thread`, drop that
    // trigger and `root` from the checks below. After every writer sets
    // kind, rerun the `kind IS NULL` backfill, add NOT NULL, and drop the
    // `kind is null or` arm.
    kind: text("kind").$type<ConversationKind>(),
    // The agent settings that every Turn keeps, typed as `AgentConfig` for
    // every kind. Set once at create. Today only a spawn writes it, so a
    // non-null value marks a child agent; readers that list or stop child
    // agents read only these.
    agentConfig: jsonb("agent_config_json").$type<AgentConfig>(),
    // Archive applies to everyone, on a root or a child. A Conversation shows
    // only while it and every ancestor are unarchived.
    archivedAt: timestamptz("archived_at"),
    // Forks are independent roots. This edge supports source/fork lookup and
    // does not affect root ownership or child conversation traversal.
    forkedFromConversationId: text("forked_from_conversation_id").references(
      (): AnyPgColumn => juniorConversations.conversationId,
      { onDelete: "set null" },
    ),
    // Set while a fork is a Quick question that nobody kept. Lists and search
    // hide it. Keep as fork clears it.
    quickQuestionAt: timestamptz("quick_question_at"),
    // The root of the tree: the Conversation itself when it has no parent,
    // else its parent's root. A Space's Lead is the root of every
    // Conversation in its Space.
    rootConversationId: text("root_conversation_id").references(
      (): AnyPgColumn => juniorConversations.conversationId,
    ),
    // The top-level Conversation: the Conversation itself when it has no
    // parent or its parent is a Lead, else its parent's. Participants,
    // pins, the sidebar, and other state of one piece of work key on it, so
    // a Space's Conversations keep them apart. Its actor and Destination own
    // the privacy boundary of the work below it. A writer of an older deploy
    // sets only the root, so the `junior_conversations_fill_top_level`
    // trigger fills it then.
    // TODO(dcramer): After every deployed writer sets it, drop that trigger,
    // rerun the backfill, and add NOT NULL.
    topLevelConversationId: text("top_level_conversation_id"),
    // The Space of a Lead. Only a Lead stores it: the other Conversations of
    // the Space are the Lead's children and read it from the Lead
    // (`rootSpaceIdSql`), so they can never disagree with it.
    spaceId: text("space_id").references(() => juniorSpaces.id),
    // Who may read the Conversation (policies/conversation-access.md).
    // Public: anyone. Private: only its root's Participants. Every row of a
    // tree has the same value: a child copies its root's when it is created,
    // and `setConversationVisibility` changes the whole tree at once. A root
    // takes the first known visibility of its Destination or Space. Null
    // reads as private: no known visibility yet, or a writer of an older
    // deploy left it null.
    visibility: text("visibility").$type<ConversationPrivacy>(),
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
      sql`${table.kind} in ('root', 'thread', 'automation', 'lead', 'task')`,
    ),
    check(
      "junior_conversations_kind_parent_check",
      sql`${table.kind} is null or ${table.kind} in ('root', 'thread') or ((${table.kind} in ('automation', 'lead')) = (${table.parentConversationId} is null))`,
    ),
    check(
      "junior_conversations_space_root_check",
      sql`${table.spaceId} is null or ${table.parentConversationId} is null`,
    ),
    check(
      "junior_conversations_visibility_check",
      sql`${table.visibility} is null or ${table.visibility} in ('public', 'private')`,
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
    // Only Leads have a Space now. The Space list reads the Lead's children.
    index("junior_conversations_space_activity_idx")
      .on(table.spaceId, table.lastActivityAt.desc())
      .where(sql`${table.spaceId} is not null`),
    index("junior_conversations_forked_from_idx").on(
      table.forkedFromConversationId,
    ),
    index("junior_conversations_root_idx").on(table.rootConversationId),
    index("junior_conversations_top_level_idx").on(
      table.topLevelConversationId,
    ),
    // Maps a Conversation to its top-level Conversation with an index-only
    // scan, so time-bounded reads such as People activity do not read every
    // wide row of this table.
    index("junior_conversations_top_level_lookup_idx").on(
      table.conversationId,
      table.topLevelConversationId,
    ),
    // One Lead per Space.
    uniqueIndex("junior_conversations_space_lead_idx")
      .on(table.spaceId)
      .where(sql`${table.kind} = 'lead'`),
    // Search reads this exact expression: `conversationSearchVector`.
    index("junior_conversations_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${table.title}, '') || ' ' || coalesce(${table.summary}, ''))`,
    ),
  ],
);
