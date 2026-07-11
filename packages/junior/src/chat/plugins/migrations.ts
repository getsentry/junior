import { createHash } from "node:crypto";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "@/db/db";

interface PluginMigrationRoot {
  /** Absolute path to the plugin's Drizzle migrations directory. */
  dir: string;
  pluginName: string;
}

interface PluginMigrationResult {
  existing: number;
  migrated: number;
  scanned: number;
}

function migrationTable(pluginName: string): string {
  const label = pluginName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256")
    .update(pluginName)
    .digest("hex")
    .slice(0, 8);
  return `__drizzle_${label}_${hash}`;
}

async function appliedMigrationTime(
  executor: JuniorSqlMigrationExecutor,
  table: string,
): Promise<number | undefined> {
  const [exists] = await executor.query<{ tableName: string | null }>(
    `SELECT to_regclass($1)::text AS "tableName"`,
    [`drizzle.${table}`],
  );
  if (!exists?.tableName) {
    return undefined;
  }
  const [row] = await executor.query<{ createdAt: string | null }>(
    `SELECT created_at::text AS "createdAt"
     FROM drizzle.${table}
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return row?.createdAt === null || row?.createdAt === undefined
    ? undefined
    : Number(row.createdAt);
}

async function legacyMigrationHashes(
  executor: JuniorSqlMigrationExecutor,
  pluginName: string,
): Promise<Set<string>> {
  const [exists] = await executor.query<{ tableName: string | null }>(
    "SELECT to_regclass('public.junior_schema_migrations')::text AS \"tableName\"",
  );
  if (!exists?.tableName) {
    return new Set();
  }
  const rows = await executor.query<{ checksum: string }>(
    `SELECT checksum
     FROM junior_schema_migrations
     WHERE id LIKE $1
     ORDER BY id ASC`,
    [`plugin:${pluginName}/%`],
  );
  return new Set(rows.map((row) => row.checksum));
}

function adoptedMigration(
  migrations: readonly MigrationMeta[],
  legacyHashes: ReadonlySet<string>,
): MigrationMeta | undefined {
  let adopted: MigrationMeta | undefined;
  for (const migration of migrations) {
    if (!legacyHashes.has(migration.hash)) {
      break;
    }
    adopted = migration;
  }
  if (!adopted && migrations.length === 1 && legacyHashes.size > 0) {
    return migrations[0];
  }
  return adopted;
}

async function adoptLegacyMigrationState(args: {
  executor: JuniorSqlMigrationExecutor;
  migrations: readonly MigrationMeta[];
  pluginName: string;
  table: string;
}): Promise<number | undefined> {
  const legacyHashes = await legacyMigrationHashes(
    args.executor,
    args.pluginName,
  );
  const migration = adoptedMigration(args.migrations, legacyHashes);
  if (!migration) {
    return undefined;
  }
  await args.executor.transaction(async () => {
    await args.executor.execute("CREATE SCHEMA IF NOT EXISTS drizzle");
    await args.executor.execute(`
CREATE TABLE IF NOT EXISTS drizzle.${args.table} (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
)
`);
    await args.executor.execute(
      `INSERT INTO drizzle.${args.table} (hash, created_at) VALUES ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
  });
  return migration.folderMillis;
}

function appliedCount(
  migrations: readonly MigrationMeta[],
  createdAt: number | undefined,
): number {
  return createdAt === undefined
    ? 0
    : migrations.filter((migration) => migration.folderMillis <= createdAt)
        .length;
}

/** Apply enabled plugins' packaged Drizzle migrations in plugin-name order. */
export async function migratePluginSchemas(
  executor: JuniorSqlMigrationExecutor,
  roots: readonly PluginMigrationRoot[],
): Promise<PluginMigrationResult> {
  const result: PluginMigrationResult = {
    existing: 0,
    migrated: 0,
    scanned: 0,
  };
  const orderedRoots = [...roots].sort((left, right) =>
    left.pluginName.localeCompare(right.pluginName),
  );
  for (const root of orderedRoots) {
    const migrations = readMigrationFiles({ migrationsFolder: root.dir });
    const table = migrationTable(root.pluginName);
    await executor.withMigrationLock(table, async () => {
      const currentTime =
        (await appliedMigrationTime(executor, table)) ??
        (await adoptLegacyMigrationState({
          executor,
          migrations,
          pluginName: root.pluginName,
          table,
        }));
      const existing = appliedCount(migrations, currentTime);
      await executor.migrate({
        migrationsFolder: root.dir,
        migrationsTable: table,
      });
      result.scanned += migrations.length;
      result.existing += existing;
      result.migrated += migrations.length - existing;
    });
  }
  return result;
}
