import { describe, expect, it } from "vitest";
import { migratePluginSchemas, type PluginMigration } from "@/chat/plugins/db";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

function migration(overrides: Partial<PluginMigration> = {}): PluginMigration {
  return {
    checksum: "checksum-1",
    filename: "0001_init.sql",
    id: "plugin:memory/0001_init.sql",
    pluginName: "memory",
    sql: "CREATE TABLE junior_memory_test (id TEXT PRIMARY KEY);",
    ...overrides,
  };
}

describe("plugin DB migrations", () => {
  it("applies pending plugin migrations against local SQL", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    const pending = migration();

    try {
      const result = await migratePluginSchemas(fixture.executor, [pending]);

      expect(result).toEqual({ existing: 0, migrated: 1, scanned: 1 });
      await fixture.executor.execute(
        "INSERT INTO junior_memory_test (id) VALUES ($1)",
        ["row-1"],
      );
      await expect(
        fixture.executor.query("SELECT id FROM junior_memory_test"),
      ).resolves.toEqual([{ id: "row-1" }]);
      await expect(
        fixture.executor.query(
          "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC",
        ),
      ).resolves.toEqual([{ id: pending.id, checksum: pending.checksum }]);
    } finally {
      await fixture.close();
    }
  });
});
