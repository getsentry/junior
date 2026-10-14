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
  "paused",
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const;

export const AGENT_INVOCATION_MAILBOX_STATUSES = [
  "pending",
  "appended",
] as const;

/**
 * Parent mailbox append state. Only terminal invocations have a value.
 * `replaced` means the child still had open work, so a later agent invocation
 * on the same child sends the result instead. `skipped` means a stop ended
 * the work, so the result is never used.
 */
export const AGENT_INVOCATION_PARENT_MAILBOX_STATUSES = [
  "pending",
  "appended",
  "replaced",
  "skipped",
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
    // TODO(dcramer): Remove destination_json after AgentRun no longer carries
    // Destination and child Runs read only the parent Conversation Location.
    destination: jsonb("destination_json").$type<Destination>().notNull(),
    // TODO(dcramer): Remove destinationVisibility after all deployed Agent
    // invocation readers ignore the destination_visibility SQL column.
    destinationVisibility: text(
      "destination_visibility",
    ).$type<ConversationPrivacy>(),
    reasoningLevel: text("reasoning_level").$type<TurnReasoningLevel>(),
    // The parent `spawnAgent` tool call. Null for runtime-started invocations.
    parentToolCallId: text("parent_tool_call_id"),
    status: text("status")
      .$type<(typeof AGENT_INVOCATION_STATUSES)[number]>()
      .notNull(),
    mailboxStatus: text("mailbox_status")
      .$type<(typeof AGENT_INVOCATION_MAILBOX_STATUSES)[number]>()
      .notNull(),
    parentMailboxStatus: text("parent_mailbox_status").$type<
      (typeof AGENT_INVOCATION_PARENT_MAILBOX_STATUSES)[number]
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
    index("junior_agent_invocations_parent_mailbox_idx").on(
      table.parentMailboxStatus,
      table.terminalAt,
    ),
  ],
);
