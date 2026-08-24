import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CodeChangeState } from "@sentry/junior-plugin-api";
import { timestamptz } from "./timestamps";

/** Repository known to Junior through an installed code plugin. */
export const juniorCodeRepositories = pgTable(
  "junior_code_repositories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    url: text("url"),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_code_repositories_provider_id_idx").on(
      table.provider,
      table.providerId,
    ),
  ],
);

/** Latest known state for one code change created by Junior. */
export const juniorCodeChanges = pgTable(
  "junior_code_changes",
  {
    id: text("id").primaryKey(),
    closedAt: timestamptz("closed_at"),
    conversationIds: text("conversation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    mergedAt: timestamptz("merged_at"),
    number: integer("number").notNull(),
    openedAt: timestamptz("opened_at").notNull(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => juniorCodeRepositories.id, { onDelete: "cascade" }),
    state: text("state").$type<CodeChangeState>().notNull(),
    title: text("title"),
    updatedAt: timestamptz("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [
    uniqueIndex("junior_code_changes_provider_id_idx").on(
      table.provider,
      table.providerId,
    ),
    index("junior_code_changes_opened_at_idx").on(table.openedAt),
    index("junior_code_changes_merged_at_idx").on(table.mergedAt),
    index("junior_code_changes_closed_at_idx").on(table.closedAt),
    index("junior_code_changes_open_idx")
      .on(table.id)
      .where(sql`${table.state} = 'open'`),
  ],
);
