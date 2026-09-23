import path from "node:path";
import { readdirSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { createEmptyJuniorSqlFixture } from "../../fixtures/sql";

const PLUGIN_NAME = "test-plugin";

function pluginMigrationsDir(): string {
  return path.resolve(process.cwd(), "tests/fixtures/plugin-migrations");
}

function pluginMigrationFiles(): string[] {
  return readdirSync(pluginMigrationsDir())
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

async function migratePlugin(
  fixture: Awaited<ReturnType<typeof createEmptyJuniorSqlFixture>>,
) {
  return await migratePluginSchemas(fixture.sql, [
    { dir: pluginMigrationsDir(), pluginName: PLUGIN_NAME },
  ]);
}

describe("plugin SQL migrations", () => {
  it("adopts exact legacy migration hashes without replaying them", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    const migrations = readMigrationFiles({
      migrationsFolder: pluginMigrationsDir(),
    });
    const migrationFiles = pluginMigrationFiles();
    expect(migrationFiles).toHaveLength(migrations.length);

    try {
      await migratePlugin(fixture);
      const [migrationTable] = await fixture.sql.query<{ tablename: string }>(`
SELECT tablename
FROM pg_tables
WHERE schemaname = 'drizzle'
  AND tablename LIKE '__drizzle_test_plugin_%'
`);
      expect(migrationTable).toBeDefined();
      await fixture.sql.execute(
        `DROP TABLE drizzle.${migrationTable!.tablename}`,
      );
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      for (const [index, migration] of migrations.entries()) {
        await fixture.sql.execute(
          `INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)`,
          [`plugin:${PLUGIN_NAME}/${migrationFiles[index]}`, migration.hash],
        );
      }

      await expect(migratePlugin(fixture)).resolves.toEqual({
        existing: migrations.length,
        migrated: 0,
        scanned: migrations.length,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("does not adopt an unknown legacy checksum", async () => {
    const fixture = await createEmptyJuniorSqlFixture();
    const migrationCount = readMigrationFiles({
      migrationsFolder: pluginMigrationsDir(),
    }).length;
    const [baselineFile] = pluginMigrationFiles();
    expect(baselineFile).toBeDefined();

    try {
      await fixture.sql.execute(`
CREATE TABLE junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`);
      await fixture.sql.execute(
        `INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)`,
        [`plugin:${PLUGIN_NAME}/${baselineFile}`, "unknown-checksum"],
      );

      await expect(migratePlugin(fixture)).resolves.toEqual({
        existing: 0,
        migrated: migrationCount,
        scanned: migrationCount,
      });
      await expect(
        fixture.sql.query<{ column_name: string }>(
          `
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'test_plugin_items'
ORDER BY column_name
`,
        ),
      ).resolves.toEqual([{ column_name: "id" }, { column_name: "note" }]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
