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
    // Ready artifact facts.
    snapshotId: text("snapshot_id"),
    buildDurationMs: integer("build_duration_ms"),
    generatedAt: timestamptz("generated_at"),
    // Builder references for check-in and snapshot-owner cleanup.
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
    check(
      "junior_snapshots_ready_fields_check",
      sql`${table.status} <> 'ready' or (${table.snapshotId} is not null and ${table.buildDurationMs} is not null and ${table.generatedAt} is not null)`,
    ),
    check(
      "junior_snapshots_build_fields_check",
      sql`${table.status} = 'ready' or (${table.buildStartedAt} is not null and ${table.buildPhase} is not null)`,
    ),
    check(
      "junior_snapshots_build_duration_check",
      sql`${table.buildDurationMs} is null or ${table.buildDurationMs} >= 0`,
    ),
    // Provider snapshot ids are unique. Nulls stay allowed for in-flight rows.
    uniqueIndex("junior_snapshots_snapshot_id_uidx").on(table.snapshotId),
    index("junior_snapshots_workspace_idx").on(table.workspaceId),
    index("junior_snapshots_workspace_profile_status_idx").on(
      table.workspaceId,
      table.profileHash,
      table.status,
    ),
    uniqueIndex("junior_snapshots_active_build_uidx")
      .on(table.workspaceId, table.profileHash)
      .where(sql`${table.status} = 'building'`),
    index("junior_snapshots_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  ],
);
