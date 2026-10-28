import { sql } from "drizzle-orm";
import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ConversationBrief } from "@/chat/briefs/schema";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/** Append-only Brief versions produced for completed Conversation turns. */
export const juniorConversationBriefs = pgTable(
  "junior_conversation_briefs",
  {
    conversationId: text("conversation_id").notNull(),
    version: integer("version").notNull(),
    turnId: text("turn_id").notNull(),
    throughSeq: integer("through_seq").notNull(),
    content: jsonb("content").$type<ConversationBrief>().notNull(),
    searchText: text("search_text").notNull(),
    modelId: text("model_id").notNull(),
    costUsd: doublePrecision("cost_usd"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_briefs_conversation_id_version_pk",
      columns: [table.conversationId, table.version],
    }),
    foreignKey({
      name: "junior_conversation_briefs_conversation_id_junior_conversations_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    uniqueIndex("junior_conversation_briefs_conversation_turn_idx").on(
      table.conversationId,
      table.turnId,
    ),
    index("junior_conversation_briefs_conversation_version_idx").on(
      table.conversationId,
      table.version.desc(),
    ),
    index("junior_conversation_briefs_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.searchText})`,
    ),
  ],
);
