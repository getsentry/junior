import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WorkspaceSnapshotBuildPhase,
  WorkspaceSnapshotStatus,
} from "@/chat/workspaces/types";
import { timestamptz } from "./timestamps";
import { juniorWorkspaces } from "./workspaces";

/**
 * Sandbox snapshot build and ready artifact for one Workspace recipe.
 * Keep prior ready rows so Vercel snapshot ids can be garbage-collected later.
 */
export const juniorSnapshots = pgTable(
  "junior_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => juniorWorkspaces.id, { onDelete: "cascade" }),
    profileHash: text("profile_hash").notNull(),
    status: text("status").$type<WorkspaceSnapshotStatus>().notNull(),
    // Ready artifact (Vercel snapshot id + Redis-equivalent details).
    snapshotId: text("snapshot_id"),
    runtime: text("runtime"),
    dependencyCount: integer("dependency_count"),
    buildDurationMs: integer("build_duration_ms"),
    generatedAt: timestamptz("generated_at"),
    // In-flight builder refs for check-in across function invocations.
    buildStartedAt: timestamptz("build_started_at"),
    buildPhase: text("build_phase").$type<WorkspaceSnapshotBuildPhase>(),
    buildSandboxName: text("build_sandbox_name"),
    buildCommandId: text("build_command_id"),
    buildError: text("build_error"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "junior_snapshots_status_check",
      sql`${table.status} in ('building', 'failed', 'ready')`,
    ),
    check(
      "junior_snapshots_build_phase_check",
      sql`${table.buildPhase} is null or ${table.buildPhase} in ('created', 'dependencies_installed', 'repositories_prepared')`,
    ),
    // Ready Vercel snapshot ids are unique. Nulls stay allowed for in-flight rows.
    uniqueIndex("junior_snapshots_snapshot_id_uidx").on(table.snapshotId),
    index("junior_snapshots_workspace_idx").on(table.workspaceId),
    index("junior_snapshots_profile_status_idx").on(
      table.profileHash,
      table.status,
    ),
    index("junior_snapshots_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  ],
);
