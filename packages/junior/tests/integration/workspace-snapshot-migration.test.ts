import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { applyCoreMigrations } from "../fixtures/conversation-sql-migrations";
import { createEmptyJuniorSqlFixture } from "../fixtures/postgres/fixture";

const coreMigrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});

describe("Workspace snapshot migration", () => {
  it("moves legacy facts and adds the active-build guard in order", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    const migrationIndex = coreMigrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('CREATE TABLE "junior_snapshots"'),
      ),
    );
    const migration = coreMigrations[migrationIndex];
    if (!migration) throw new Error("Workspace snapshot migration not found");
    const activeBuildMigrationIndex = coreMigrations.findIndex((candidate) =>
      candidate.sql.some((statement) =>
        statement.includes("junior_snapshots_active_build_uidx"),
      ),
    );
    if (activeBuildMigrationIndex <= migrationIndex) {
      throw new Error("Workspace active-build migration not found");
    }

    try {
      await applyCoreMigrations(fixture, coreMigrations, 0, migrationIndex);
      await fixture.sql.execute(`
INSERT INTO junior_workspaces (
  id, name, setup_script, snapshot_id, snapshot_generated_at,
  snapshot_build_duration_ms, snapshot_profile_hash, created_at, updated_at
) VALUES (
  'workspace-legacy-snapshot', 'legacy-snapshot', '', 'snap_legacy',
  '2026-03-01T00:00:00.000Z', 12345, 'profile-legacy',
  '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
)
`);
      for (const statement of migration.sql) {
        await fixture.sql.execute(statement);
      }

      const [snapshot] = await fixture.sql.query<{
        buildDurationMs: number;
        generatedAt: Date;
        profileHash: string;
        snapshotId: string;
        status: string;
        workspaceId: string;
      }>(`
SELECT
  workspace_id AS "workspaceId", profile_hash AS "profileHash", status,
  snapshot_id AS "snapshotId", build_duration_ms AS "buildDurationMs",
  generated_at AS "generatedAt"
FROM junior_snapshots
`);
      expect(snapshot).toMatchObject({
        buildDurationMs: 12_345,
        profileHash: "profile-legacy",
        snapshotId: "snap_legacy",
        status: "ready",
        workspaceId: "workspace-legacy-snapshot",
      });
      expect(snapshot?.generatedAt.toISOString()).toBe(
        "2026-03-01T00:00:00.000Z",
      );
      await expect(
        fixture.sql.execute(`
INSERT INTO junior_snapshots (
  id, workspace_id, profile_hash, status, created_at, updated_at
) VALUES (
  'invalid-ready', 'workspace-legacy-snapshot', 'profile-invalid', 'ready',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
`),
      ).rejects.toThrow(/junior_snapshots_ready_fields_check/);
      await applyCoreMigrations(
        fixture,
        coreMigrations,
        migrationIndex + 1,
        activeBuildMigrationIndex + 1,
      );
      await fixture.sql.execute(`
INSERT INTO junior_snapshots (
  id, workspace_id, profile_hash, status, build_started_at, build_phase,
  created_at, updated_at
) VALUES (
  'active-build-one', 'workspace-legacy-snapshot', 'profile-active', 'building',
  CURRENT_TIMESTAMP, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
`);
      await expect(
        fixture.sql.execute(`
INSERT INTO junior_snapshots (
  id, workspace_id, profile_hash, status, build_started_at, build_phase,
  created_at, updated_at
) VALUES (
  'active-build-two', 'workspace-legacy-snapshot', 'profile-active', 'building',
  CURRENT_TIMESTAMP, 'created', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
`),
      ).rejects.toThrow(/junior_snapshots_active_build_uidx/);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
