import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { JuniorSqlMigrationExecutor } from "@/db/db";

const PLUGIN_SCHEMA_LOCK_NAME = "junior_plugin_schema";
const MIGRATION_FILENAME_RE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

const migrationRecordSchema = z
  .object({
    id: z.string().min(1),
    checksum: z.string().min(1),
  })
  .strict();

export interface PluginMigration {
  checksum: string;
  filename: string;
  id: string;
  pluginName: string;
  sql: string;
}

export interface PluginMigrationRoot {
  /** Absolute path to the plugin's migrations directory. */
  dir: string;
  pluginName: string;
}

export interface PluginMigrationResult {
  existing: number;
  migrated: number;
  scanned: number;
}

interface StoredMigrationRecord {
  checksum: string;
  id: string;
}

function checksumSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function parseStoredMigrationRecord(value: unknown): StoredMigrationRecord {
  return migrationRecordSchema.parse(value);
}

function assertMigrationFilename(filename: string): void {
  if (
    !filename ||
    filename !== path.basename(filename) ||
    !MIGRATION_FILENAME_RE.test(filename)
  ) {
    throw new Error(`Plugin migration filename "${filename}" is invalid`);
  }
}

function assertUniqueMigrationIds(
  migrations: readonly PluginMigration[],
): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate plugin migration id ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

function migrationId(pluginName: string, filename: string): string {
  return `plugin:${pluginName}/${filename}`;
}

function createMigrationTableSql(): string {
  return `
CREATE TABLE IF NOT EXISTS junior_schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`;
}

async function listAppliedMigrations(
  executor: JuniorSqlMigrationExecutor,
): Promise<Map<string, StoredMigrationRecord>> {
  const rows = await executor.query(
    "SELECT id, checksum FROM junior_schema_migrations ORDER BY id ASC",
  );
  const records = new Map<string, StoredMigrationRecord>();
  for (const row of rows) {
    const record = parseStoredMigrationRecord(row);
    records.set(record.id, record);
  }
  return records;
}

async function applyPluginMigration(
  executor: JuniorSqlMigrationExecutor,
  migration: PluginMigration,
): Promise<void> {
  await executor.transaction(async () => {
    await executor.execute(migration.sql);
    await executor.execute(
      "INSERT INTO junior_schema_migrations (id, checksum) VALUES ($1, $2)",
      [migration.id, migration.checksum],
    );
  });
}

/** Read committed SQL migration artifacts for one enabled plugin root. */
export function readPluginMigrations(
  root: PluginMigrationRoot,
): PluginMigration[] {
  const migrationsDir = root.dir;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(migrationsDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Plugin "${root.pluginName}" migrations path is not a directory`,
    );
  }

  return readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => {
      assertMigrationFilename(filename);
      const sql = readFileSync(path.join(migrationsDir, filename), "utf8");
      if (!sql.trim()) {
        throw new Error(
          `Plugin "${root.pluginName}" migration "${filename}" is empty`,
        );
      }
      return {
        checksum: checksumSql(sql),
        filename,
        id: migrationId(root.pluginName, filename),
        pluginName: root.pluginName,
        sql,
      };
    });
}

/** Apply plugin-owned SQL migrations after core Junior migrations. */
export async function migratePluginSchemas(
  executor: JuniorSqlMigrationExecutor,
  migrations: readonly PluginMigration[],
): Promise<PluginMigrationResult> {
  assertUniqueMigrationIds(migrations);
  const result: PluginMigrationResult = {
    existing: 0,
    migrated: 0,
    scanned: migrations.length,
  };
  await executor.withLock(PLUGIN_SCHEMA_LOCK_NAME, async () => {
    await executor.execute(createMigrationTableSql());
    const applied = await listAppliedMigrations(executor);
    for (const migration of migrations) {
      const existing = applied.get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Plugin migration ${migration.id} checksum changed`);
        }
        result.existing++;
        continue;
      }
      await applyPluginMigration(executor, migration);
      result.migrated++;
    }
  });
  return result;
}
