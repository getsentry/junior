import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Actor, Destination, Source } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { CredentialContext } from "@/chat/credentials/context";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

export const AGENT_INVOCATION_STATUSES = [
  "pending",
  "running",
  "awaiting_resume",
  "blocked",
  "completed",
  "failed",
] as const;

export const AGENT_INVOCATION_MAILBOX_STATUSES = [
  "pending",
  "appended",
] as const;

/** Parent-mailbox delivery for one terminal agent invocation result. */
export const AGENT_INVOCATION_PARENT_NOTIFICATION_STATUSES = [
  "pending",
  "notified",
  "failed",
] as const;

export const juniorAgentBindings = pgTable(
  "junior_agent_bindings",
  {
    parentConversationId: text("parent_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    name: text("name").notNull(),
    childConversationId: text("child_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
  },
  (table) => [
    primaryKey({
      columns: [table.parentConversationId, table.name],
    }),
    uniqueIndex("junior_agent_bindings_child_idx").on(
      table.childConversationId,
    ),
  ],
);

export const juniorAgentInvocations = pgTable(
  "junior_agent_invocations",
  {
    invocationId: text("invocation_id").primaryKey(),
    parentConversationId: text("parent_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    childConversationId: text("child_conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    agentName: text("agent_name"),
    input: text("input").notNull(),
    actor: jsonb("actor_json").$type<Actor>().notNull(),
    credentialContext: jsonb(
      "credential_context_json",
    ).$type<CredentialContext>(),
    source: jsonb("source_json").$type<Source>().notNull(),
    destination: jsonb("destination_json").$type<Destination>().notNull(),
    destinationVisibility: text(
      "destination_visibility",
    ).$type<ConversationPrivacy>(),
    reasoningLevel: text("reasoning_level").$type<TurnReasoningLevel>(),
    status: text("status")
      .$type<(typeof AGENT_INVOCATION_STATUSES)[number]>()
      .notNull(),
    mailboxStatus: text("mailbox_status")
      .$type<(typeof AGENT_INVOCATION_MAILBOX_STATUSES)[number]>()
      .notNull(),
    parentNotificationStatus: text("parent_notification_status").$type<
      (typeof AGENT_INVOCATION_PARENT_NOTIFICATION_STATUSES)[number]
    >(),
    result: text("result"),
    errorMessage: text("error_message"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    terminalAt: timestamptz("terminal_at"),
  },
  (table) => [
    index("junior_agent_invocations_child_idx").on(table.childConversationId),
    index("junior_agent_invocations_mailbox_idx").on(
      table.mailboxStatus,
      table.createdAt,
    ),
    index("junior_agent_invocations_parent_notification_idx").on(
      table.parentNotificationStatus,
      table.terminalAt,
    ),
  ],
);
