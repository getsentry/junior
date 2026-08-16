import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { WorkspaceSnapshotStatus } from "@/chat/workspaces/types";
import { timestamptz } from "./timestamps";

/** Named recipe used to prepare a reusable Sandbox. */
export const juniorWorkspaces = pgTable(
  "junior_workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    setupScript: text("setup_script").notNull().default(""),
    // Full Workspace snapshot record. Redis remains a hot cache for resolve.
    snapshotId: text("snapshot_id"),
    snapshotGeneratedAt: timestamptz("snapshot_generated_at"),
    snapshotBuildDurationMs: integer("snapshot_build_duration_ms"),
    snapshotProfileHash: text("snapshot_profile_hash"),
    snapshotRuntime: text("snapshot_runtime"),
    snapshotDependencyCount: integer("snapshot_dependency_count"),
    // TODO: garbage-collect these Vercel snapshots once retention policy exists.
    previousSnapshotIds: jsonb("previous_snapshot_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    snapshotStatus: text("snapshot_status").$type<WorkspaceSnapshotStatus>(),
    snapshotBuildProfileHash: text("snapshot_build_profile_hash"),
    snapshotBuildStartedAt: timestamptz("snapshot_build_started_at"),
    snapshotBuildSandboxName: text("snapshot_build_sandbox_name"),
    snapshotBuildCommandId: text("snapshot_build_command_id"),
    snapshotBuildError: text("snapshot_build_error"),
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
