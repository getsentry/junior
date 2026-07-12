/** SQL schema migrations for durable Junior records. */
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { juniorSqlSchema as schema } from "@/db/schema";

const LEGACY_CORE_MIGRATION_IDS = [
  "0001_conversation_core",
  "0002_slack_destination_visibility_backfill",
  "0003_user_identities",
  "0004_actor_cutover",
  "0005_conversation_transcripts",
] as const;
const LEGACY_METRICS_MIGRATION_ID = "0006_conversation_metrics";
const MIGRATIONS_TABLE = "__drizzle_junior_core";

/** Resolve the packaged Drizzle migration directory in source or built output. */
function migrationFolder(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot =
    basename(moduleDir) === "dist"
      ? dirname(moduleDir)
      : basename(dirname(moduleDir)) === "dist"
        ? resolve(moduleDir, "../..")
        : resolve(moduleDir, "../../../..");
  return join(packageRoot, "migrations");
}

async function adoptLegacyMigrationState(
  executor: JuniorSqlMigrationExecutor,
  migrationsFolder: string,
): Promise<void> {
  const [tables] = await executor.query<{
    drizzleTable: string | null;
    legacyTable: string | null;
  }>(`
SELECT
  to_regclass('drizzle.__drizzle_junior_core')::text AS "drizzleTable",
  to_regclass('public.junior_schema_migrations')::text AS "legacyTable"
`);
  if (!tables?.legacyTable || tables.drizzleTable) {
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  const [metrics] = await executor.query<{ complete: boolean }>(`
SELECT count(*) = 4 AS complete
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'junior_conversations'
  AND column_name IN (
    'duration_ms',
    'usage_json',
    'execution_duration_ms',
    'execution_usage_json'
  )
`);
  const legacyRecords = await executor.query<{
    checksum: string;
    id: string;
  }>("SELECT id, checksum FROM junior_schema_migrations");
  const expectedIds = metrics?.complete
    ? [...LEGACY_CORE_MIGRATION_IDS, LEGACY_METRICS_MIGRATION_ID]
    : [...LEGACY_CORE_MIGRATION_IDS];
  const validIds = new Set(
    legacyRecords
      .filter((record) => record.checksum.trim().length > 0)
      .map((record) => record.id),
  );
  const missingIds = expectedIds.filter((id) => !validIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(
      `Cannot adopt partial legacy core migration state; missing: ${missingIds.join(", ")}`,
    );
  }

  const migration = metrics?.complete ? migrations[1] : migrations[0];
  if (!migration) {
    throw new Error("No core Drizzle migrations were packaged");
  }

  await executor.transaction(async () => {
    await executor.execute("CREATE SCHEMA IF NOT EXISTS drizzle");
    await executor.execute(`
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_junior_core (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
)
`);
    await executor.execute(
      `INSERT INTO drizzle.__drizzle_junior_core (hash, created_at)
       VALUES ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
  });
}

export { schema };

/** Apply the packaged Drizzle migrations during `junior upgrade`. */
export async function migrateSchema(
  executor: JuniorSqlMigrationExecutor,
): Promise<void> {
  const migrationsFolder = migrationFolder();
  await executor.withMigrationLock(MIGRATIONS_TABLE, async () => {
    await adoptLegacyMigrationState(executor, migrationsFolder);
    await executor.migrate({
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
  });
}
