import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  migratePluginSchemas,
  readPluginMigrations,
  type PluginMigration,
} from "@/chat/plugins/db";
import type { JuniorSqlMigrationExecutor } from "@/db/db";

class FakeSqlExecutor implements JuniorSqlMigrationExecutor {
  readonly locks: string[] = [];
  readonly statements: string[] = [];
  readonly transactions: string[][] = [];
  private activeTransaction: string[] | undefined;
  private readonly applied = new Map<string, string>();

  constructor(applied?: Iterable<readonly [string, string]>) {
    if (applied) {
      this.applied = new Map(applied);
    }
  }

  db(): never {
    throw new Error("Fake plugin migration executor does not support Drizzle");
  }

  async execute(statement: string, params: readonly unknown[] = []) {
    const normalized = statement.trim();
    this.statements.push(normalized);
    this.activeTransaction?.push(normalized);
    if (normalized.startsWith("INSERT INTO junior_schema_migrations")) {
      this.applied.set(String(params[0]), String(params[1]));
    }
  }

  async query<T = unknown>(statement: string): Promise<T[]> {
    const normalized = statement.trim();
    this.statements.push(normalized);
    if (
      normalized ===
      "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC"
    ) {
      return [...this.applied.entries()].map(([id, checksum]) => ({
        id,
        checksum,
      })) as T[];
    }
    throw new Error(`Unexpected query: ${statement}`);
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const statements: string[] = [];
    this.transactions.push(statements);
    this.activeTransaction = statements;
    try {
      return await callback();
    } finally {
      this.activeTransaction = undefined;
    }
  }

  async withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T> {
    this.locks.push(lockName);
    return await callback();
  }
}

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
  it("runs pending plugin migrations under the plugin schema lock", async () => {
    const executor = new FakeSqlExecutor();

    const result = await migratePluginSchemas(executor, [migration()]);

    expect(result).toEqual({ existing: 0, migrated: 1, scanned: 1 });
    expect(executor.locks).toEqual(["junior_plugin_schema"]);
    expect(executor.statements[0]).toContain(
      "CREATE TABLE IF NOT EXISTS junior_schema_migrations",
    );
    expect(executor.transactions).toHaveLength(1);
    expect(executor.transactions[0]).toEqual(
      expect.arrayContaining([
        "CREATE TABLE junior_memory_test (id TEXT PRIMARY KEY);",
        expect.stringContaining("INSERT INTO junior_schema_migrations"),
      ]),
    );
  });

  it("does not reapply plugin migrations already recorded with the same checksum", async () => {
    const applied = migration();
    const executor = new FakeSqlExecutor([[applied.id, applied.checksum]]);

    const result = await migratePluginSchemas(executor, [applied]);

    expect(result).toEqual({ existing: 1, migrated: 0, scanned: 1 });
    expect(executor.transactions).toHaveLength(0);
  });

  it("fails when an applied plugin migration checksum has changed", async () => {
    const applied = migration();
    const executor = new FakeSqlExecutor([[applied.id, "old-checksum"]]);

    await expect(migratePluginSchemas(executor, [applied])).rejects.toThrow(
      "Plugin migration plugin:memory/0001_init.sql checksum changed",
    );
  });

  it("reads sorted SQL files from a plugin migrations directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "junior-plugin-migrations-"));
    const migrationsDir = path.join(root, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(
      path.join(migrationsDir, "0002_second.sql"),
      "CREATE TABLE junior_memory_second_plugin_table (id TEXT PRIMARY KEY);",
    );
    writeFileSync(
      path.join(migrationsDir, "0001_first.sql"),
      "CREATE TABLE junior_memory_first_plugin_table (id TEXT PRIMARY KEY);",
    );

    try {
      const migrations = readPluginMigrations({
        dir: migrationsDir,
        pluginName: "memory",
      });

      expect(migrations.map((item) => item.id)).toEqual([
        "plugin:memory/0001_first.sql",
        "plugin:memory/0002_second.sql",
      ]);
      expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts plugin SQL without inspecting object ownership", () => {
    const root = mkdtempSync(path.join(tmpdir(), "junior-plugin-migrations-"));
    const migrationsDir = path.join(root, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(
      path.join(migrationsDir, "0001_init.sql"),
      [
        "CREATE TABLE junior_memory_entries (id TEXT PRIMARY KEY);",
        "CREATE INDEX junior_memory_entries_created_idx",
        "  ON junior_memory_entries (id);",
        "INSERT INTO junior_memory_entries (id) VALUES ('seed');",
      ].join("\n"),
    );

    try {
      const migrations = readPluginMigrations({
        dir: migrationsDir,
        pluginName: "memory",
      });

      expect(migrations).toHaveLength(1);
      expect(migrations[0]?.sql).toContain("INSERT INTO");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects migration filenames outside the committed SQL pattern", () => {
    const root = mkdtempSync(path.join(tmpdir(), "junior-plugin-migrations-"));
    const migrationsDir = path.join(root, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(
      path.join(migrationsDir, "init.sql"),
      "CREATE TABLE junior_memory_test (id TEXT PRIMARY KEY);",
    );

    try {
      expect(() =>
        readPluginMigrations({
          dir: migrationsDir,
          pluginName: "memory",
        }),
      ).toThrow('Plugin migration filename "init.sql" is invalid');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects duplicate plugin migration ids before applying SQL", async () => {
    const executor = new FakeSqlExecutor();
    const pending = migration();

    await expect(
      migratePluginSchemas(executor, [
        pending,
        migration({ checksum: "checksum-2" }),
      ]),
    ).rejects.toThrow(
      "Duplicate plugin migration id plugin:memory/0001_init.sql",
    );
    expect(executor.statements).toEqual([]);
  });
});
