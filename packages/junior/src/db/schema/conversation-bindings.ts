import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Provider conversation coordinates bound to Junior's opaque durable conversation id. */
export const juniorConversationBindings = pgTable(
  "junior_conversation_bindings",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    // TODO(dcramer): Rename provider_destination_id with the Location SQL
    // migration. It identifies the provider place that contains the thread.
    providerDestinationId: text("provider_destination_id").notNull(),
    providerConversationId: text("provider_conversation_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_bindings_provider_conversation_pk",
      columns: [
        table.provider,
        table.providerTenantId,
        table.providerDestinationId,
        table.providerConversationId,
      ],
    }),
    index("junior_conversation_bindings_conversation_idx").on(
      table.conversationId,
    ),
  ],
);
