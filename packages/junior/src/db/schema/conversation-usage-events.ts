import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { AgentTurnUsage } from "@/chat/usage";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

export const juniorConversationUsageEvents = pgTable(
  "junior_conversation_usage_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId, {
        onDelete: "cascade",
      }),
    usage: jsonb("usage_json").$type<AgentTurnUsage>().notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
);
