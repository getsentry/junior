import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Provider thread coordinates bound to Junior's opaque durable conversation id. */
export const juniorConversationBindings = pgTable(
  "junior_conversation_bindings",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => juniorConversations.conversationId),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    providerDestinationId: text("provider_destination_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_conversation_bindings_provider_thread_uidx").on(
      table.provider,
      table.providerTenantId,
      table.providerDestinationId,
      table.providerThreadId,
    ),
    index("junior_conversation_bindings_destination_idx").on(
      table.provider,
      table.providerTenantId,
      table.providerDestinationId,
    ),
  ],
);
