import { createHash } from "node:crypto";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import {
  pendingMigrations,
  readMigrationRecords,
  type MigrationRecord,
} from "@/db/migrate";

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

export interface PluginMigrationSummary extends PluginMigrationResult {
  pluginName: string;
}

interface PluginMigrationOptions {
  onPluginMigration?: (summary: PluginMigrationSummary) => void;
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

/** The migrations, from the first, whose SQL the legacy table records. */
function adoptedMigrations(
  migrations: readonly MigrationMeta[],
  legacyHashes: ReadonlySet<string>,
): MigrationMeta[] {
  const unknown = migrations.findIndex(
    (migration) => !legacyHashes.has(migration.hash),
  );
  return unknown === -1 ? [...migrations] : migrations.slice(0, unknown);
}

async function adoptLegacyMigrationState(args: {
  executor: JuniorSqlMigrationExecutor;
  migrations: readonly MigrationMeta[];
  pluginName: string;
  table: string;
}): Promise<MigrationRecord[] | undefined> {
  const legacyHashes = await legacyMigrationHashes(
    args.executor,
    args.pluginName,
  );
  const adopted = adoptedMigrations(args.migrations, legacyHashes);
  if (adopted.length === 0) {
    return undefined;
  }
  const table = `drizzle.${args.table}`;
  await args.executor.transaction(async () => {
    await args.executor.execute("CREATE SCHEMA IF NOT EXISTS drizzle");
    await args.executor.execute(`
CREATE TABLE IF NOT EXISTS ${table} (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT,
  name TEXT,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
)
`);
    /* oxlint-disable no-await-in-loop -- Record the adopted migrations in order. */
    for (const migration of adopted) {
      await args.executor.execute(
        `INSERT INTO ${table} (hash, created_at, name, applied_at) VALUES ($1, $2, $3, NULL)`,
        [migration.hash, migration.folderMillis, migration.name],
      );
    }
    /* oxlint-enable no-await-in-loop */
  });
  return await readMigrationRecords(args.executor, table);
}

/** Apply enabled plugins' packaged Drizzle migrations in plugin-name order. */
export async function migratePluginSchemas(
  executor: JuniorSqlMigrationExecutor,
  roots: readonly PluginMigrationRoot[],
  options: PluginMigrationOptions = {},
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
    if (migrations.length === 0) {
      continue;
    }
    const table = migrationTable(root.pluginName);
    // oxlint-disable-next-line no-await-in-loop -- Migrate one plugin at a time, in name order.
    const initialRecords = await readMigrationRecords(
      executor,
      `drizzle.${table}`,
    );
    if (pendingMigrations(migrations, initialRecords ?? []).length === 0) {
      const summary = {
        existing: migrations.length,
        migrated: 0,
        pluginName: root.pluginName,
        scanned: migrations.length,
      };
      result.scanned += summary.scanned;
      result.existing += summary.existing;
      options.onPluginMigration?.(summary);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Migrate one plugin at a time, in name order.
    const summary = await executor.withMigrationLock(table, async () => {
      const current = await readMigrationRecords(executor, `drizzle.${table}`);
      const records = current?.length
        ? current
        : await adoptLegacyMigrationState({
            executor,
            migrations,
            pluginName: root.pluginName,
            table,
          });
      const migrated = pendingMigrations(migrations, records ?? []).length;
      if (migrated > 0) {
        await executor.migrate({
          migrationsFolder: root.dir,
          migrationsTable: table,
        });
      }
      return {
        existing: migrations.length - migrated,
        migrated,
        pluginName: root.pluginName,
        scanned: migrations.length,
      };
    });
    result.scanned += summary.scanned;
    result.existing += summary.existing;
    result.migrated += summary.migrated;
    options.onPluginMigration?.(summary);
  }
  return result;
}
