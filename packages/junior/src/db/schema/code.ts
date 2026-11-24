import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CodeChangeState } from "@sentry/junior-plugin-api";
import { timestamptz } from "./timestamps";

/**
 * Words of a repository name, for prefix search. `owner/repo` is one token
 * to the text parser, so the slash becomes a space.
 */
export function codeRepositorySearchDocument(table: {
  name: AnyPgColumn;
}): SQL {
  return sql`to_tsvector('simple', translate(${table.name}, '/', ' '))`;
}

/** The number and the title words of a code change, for prefix search. */
export function codeChangeSearchDocument(table: {
  number: AnyPgColumn;
  title: AnyPgColumn;
}): SQL {
  return sql`to_tsvector('simple', ${table.number}::text || ' ' || coalesce(${table.title}, ''))`;
}

/** Repository known to Junior through an installed code plugin. */
export const juniorCodeRepositories = pgTable(
  "junior_code_repositories",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_code_repositories_provider_id_idx").on(
      table.provider,
      table.providerId,
    ),
    index("junior_code_repositories_search_idx").using(
      "gin",
      codeRepositorySearchDocument(table),
    ),
  ],
);

/** Latest known state for one code change created by Junior. */
export const juniorCodeChanges = pgTable(
  "junior_code_changes",
  {
    id: uuid("id").primaryKey(),
    closedAt: timestamptz("closed_at"),
    conversationIds: text("conversation_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Latest push, review, or comment by a person, from the code plugin. */
    lastActivityAt: timestamptz("last_activity_at"),
    mergedAt: timestamptz("merged_at"),
    number: integer("number").notNull(),
    openedAt: timestamptz("opened_at").notNull(),
    provider: text("provider").notNull(),
    providerId: text("provider_id").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => juniorCodeRepositories.id, { onDelete: "cascade" }),
    state: text("state").$type<CodeChangeState>().notNull(),
    title: text("title"),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("junior_code_changes_provider_id_idx").on(
      table.provider,
      table.providerId,
    ),
    index("junior_code_changes_opened_at_idx").on(table.openedAt),
    index("junior_code_changes_merged_at_idx").on(table.mergedAt),
    index("junior_code_changes_closed_at_idx").on(table.closedAt),
    // Repository pages count changes by state and list one state newest
    // first.
    index("junior_code_changes_repository_state_idx").on(
      table.repositoryId,
      table.state,
      table.updatedAt.desc(),
    ),
    index("junior_code_changes_search_idx").using(
      "gin",
      codeChangeSearchDocument(table),
    ),
    index("junior_code_changes_open_idx")
      .on(table.id)
      .where(sql`${table.state} = 'open'`),
  ],
);
