import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migratePluginSchemas, type PluginMigration } from "@/chat/plugins/db";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

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
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    fixture = await createLocalJuniorSqlFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("applies pending plugin migrations against local SQL", async () => {
    const pending = migration();

    const result = await migratePluginSchemas(fixture.sql, [pending]);

    expect(result).toEqual({ existing: 0, migrated: 1, scanned: 1 });
    await fixture.sql.execute(
      "INSERT INTO junior_memory_test (id) VALUES ($1)",
      ["row-1"],
    );
    await expect(
      fixture.sql.query("SELECT id FROM junior_memory_test"),
    ).resolves.toEqual([{ id: "row-1" }]);
    await expect(
      fixture.sql.query(
        "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC",
      ),
    ).resolves.toEqual([{ id: pending.id, checksum: pending.checksum }]);
  });
});
