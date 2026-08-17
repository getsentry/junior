import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { applyCoreMigrations } from "../fixtures/conversation-sql-migrations";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

const coreMigrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
});

describe("Workspace snapshot migration", () => {
  it("moves legacy snapshot facts into snapshot history", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const migrationIndex = coreMigrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('CREATE TABLE "junior_snapshots"'),
      ),
    );
    const migration = coreMigrations[migrationIndex];
    if (!migration) throw new Error("Workspace snapshot migration not found");

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
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
