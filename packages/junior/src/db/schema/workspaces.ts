import { pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** Named recipe used to prepare a reusable Sandbox. */
export const juniorWorkspaces = pgTable(
  "junior_workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    setupScript: text("setup_script").notNull().default(""),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [uniqueIndex("junior_workspaces_name_idx").on(table.name)],
);

/** Repository included in one Workspace recipe. */
export const juniorWorkspaceRepos = pgTable(
  "junior_workspace_repos",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => juniorWorkspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    repo: text("repo").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.provider, table.repo] }),
  ],
);
