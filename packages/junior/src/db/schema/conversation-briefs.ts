import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    // TODO: drop in the release after micro-USD. Only the runtime before it
    // writes this USD cost, and a repair migration converts those rows.
    legacyCostUsd: doublePrecision("cost_usd"),
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
    // The System page counts the Briefs of a recent window.
    index("junior_conversation_briefs_created_at_idx").on(table.createdAt),
    index("junior_conversation_briefs_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.searchText})`,
    ),
  ],
);

/**
 * All-time Brief totals for the System page, so the report does not read
 * every Brief. A deferred trigger on `junior_conversation_briefs` keeps the
 * one row exact for every insert and delete (migration 0131).
 */
export const juniorConversationBriefTotals = pgTable(
  "junior_conversation_brief_totals",
  {
    id: boolean("id").primaryKey().default(true),
    stored: bigint("stored", { mode: "number" }).notNull(),
    // Counts version 1 rows. Versions start at 1, and a purge deletes every
    // version, so a Conversation has Briefs exactly when it has version 1.
    conversations: bigint("conversations", { mode: "number" }).notNull(),
  },
  (table) => [
    check("junior_conversation_brief_totals_one_row", sql`${table.id}`),
  ],
);
