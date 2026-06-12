import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorDestinations } from "./destinations";
import { juniorIdentities } from "./identities";
import { timestamptz } from "./timestamps";
import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackRequester } from "@/chat/requester";
import type {
  AgentInput,
  ExecutionStatus,
  Source,
} from "../../state-task-execution-store";

export const juniorConversations = pgTable(
  "junior_conversations",
  {
    conversationId: text("conversation_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    source: text("source").$type<Source>(),
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
    requesterIdentityId: text("requester_identity_id").references(
      () => juniorIdentities.id,
    ),
    creatorIdentityId: text("creator_identity_id").references(
      () => juniorIdentities.id,
    ),
    credentialSubjectIdentityId: text(
      "credential_subject_identity_id",
    ).references(() => juniorIdentities.id),
    requester: jsonb("requester_json").$type<StoredSlackRequester>(),
    channelName: text("channel_name"),
    title: text("title"),
    createdAt: timestamptz("created_at").notNull(),
    lastActivityAt: timestamptz("last_activity_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    executionUpdatedAt: timestamptz("execution_updated_at"),
    executionStatus: text("execution_status")
      .$type<ExecutionStatus>()
      .notNull(),
    runId: text("run_id"),
    lastCheckpointAt: timestamptz("last_checkpoint_at"),
    lastEnqueuedAt: timestamptz("last_enqueued_at"),
    leaseToken: text("lease_token"),
    leaseAcquiredAt: timestamptz("lease_acquired_at"),
    leaseLastCheckInAt: timestamptz("lease_last_check_in_at"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
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
    index("junior_conversations_requester_activity_idx").on(
      table.requesterIdentityId,
      table.lastActivityAt.desc(),
    ),
    index("junior_conversations_origin_idx").on(
      table.originType,
      table.originId,
      table.lastActivityAt.desc(),
    ),
  ],
);

export const juniorConversationInboundMessages = pgTable(
  "junior_conversation_inbound_messages",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    inboundMessageId: text("inbound_message_id").notNull(),
    source: text("source").$type<Source>().notNull(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => juniorDestinations.id),
    destination: jsonb("destination_json").$type<Destination>().notNull(),
    input: jsonb("input_json").$type<AgentInput>(),
    inputTextLength: integer("input_text_length").notNull().default(0),
    attachmentCount: integer("attachment_count").notNull().default(0),
    createdAt: timestamptz("created_at").notNull(),
    receivedAt: timestamptz("received_at").notNull(),
    injectedAt: timestamptz("injected_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.inboundMessageId],
    }),
    index("junior_conversation_inbound_pending_idx")
      .on(
        table.conversationId,
        table.createdAt,
        table.receivedAt,
        table.inboundMessageId,
      )
      .where(sql`${table.injectedAt} IS NULL`),
  ],
);
