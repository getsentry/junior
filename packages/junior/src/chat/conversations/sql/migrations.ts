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
// Pinned output of the pre-Drizzle runner's SHA-256(statement + NUL) algorithm.
const LEGACY_CORE_MIGRATION_CHECKSUMS = {
  "0001_conversation_core":
    "78fe050d8bec8ba18e2e3192497b3d8ad6b45fbb66ad4859377fb2202ed57651",
  "0002_slack_destination_visibility_backfill":
    "fb590a09fa51db471a748e3d7abb4137f521ee8df97f6e9ef5563121be98c394",
  "0003_user_identities":
    "67d9c9c26cbd76213614eb6d7a7cc7e2501fc20e92321eb5176a08ce39cd2efb",
  "0004_actor_cutover":
    "d41b8bfa66b8a88d69e84af38950025ba4c9be56341565cbe1411f0ca50c1dc2",
  "0005_conversation_transcripts":
    "add299d1b254e023f89b5993c417dd2248dc009e874efdeaf31ec0732e0d4fb4",
  "0006_conversation_metrics":
    "7c7ca5c9e11ed4b0e14737fd90d3348ea46e306c88fdf31199b7afb2a11c6a41",
} as const;
type LegacyCoreMigrationId = keyof typeof LEGACY_CORE_MIGRATION_CHECKSUMS;
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
  const [metrics] = await executor.query<{ columnCount: number }>(`
SELECT count(*)::integer AS "columnCount"
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
  const legacyRecordsById = new Map(
    legacyRecords.map((record) => [record.id, record.checksum]),
  );
  const metricColumnCount = metrics?.columnCount ?? 0;
  if (metricColumnCount !== 0 && metricColumnCount !== 4) {
    throw new Error(
      `Cannot adopt partial legacy metrics state: found ${metricColumnCount} of 4 required columns`,
    );
  }
  const metricsComplete = metricColumnCount === 4;
  const hasMetricsRecord = legacyRecordsById.has(LEGACY_METRICS_MIGRATION_ID);
  if (metricsComplete !== hasMetricsRecord) {
    throw new Error(
      "Cannot adopt legacy core migration state: legacy metrics migration record does not match physical metric columns",
    );
  }
  const expectedIds: readonly LegacyCoreMigrationId[] = metricsComplete
    ? [...LEGACY_CORE_MIGRATION_IDS, LEGACY_METRICS_MIGRATION_ID]
    : [...LEGACY_CORE_MIGRATION_IDS];
  const missingIds = expectedIds.filter((id) => !legacyRecordsById.has(id));
  if (missingIds.length > 0) {
    throw new Error(
      `Cannot adopt partial legacy core migration state; missing: ${missingIds.join(", ")}`,
    );
  }
  const checksumMismatches = expectedIds.filter(
    (id) => legacyRecordsById.get(id) !== LEGACY_CORE_MIGRATION_CHECKSUMS[id],
  );
  if (checksumMismatches.length > 0) {
    throw new Error(
      `Cannot adopt legacy core migration state: checksum mismatch: ${checksumMismatches.join(", ")}`,
    );
  }

  const [baseline] = await executor.query<{
    conversationEventsTable: string | null;
    legacyAgentStepsTable: boolean;
    metricRunIdColumn: boolean;
    searchIndex: string | null;
  }>(`
SELECT
  to_regclass('public.junior_conversation_events')::text AS "conversationEventsTable",
  to_regclass('public.junior_conversation_messages_search_idx')::text AS "searchIndex",
  EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'junior_agent_steps'
      AND table_type = 'BASE TABLE'
  ) AS "legacyAgentStepsTable",
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'junior_conversations'
      AND column_name = 'metric_run_id'
  ) AS "metricRunIdColumn"
`);
  if (!baseline?.legacyAgentStepsTable || baseline.conversationEventsTable) {
    throw new Error(
      "Cannot adopt legacy core migration state: expected the pre-Drizzle junior_agent_steps table and no junior_conversation_events table",
    );
  }
  const postBaselineMarkers = [
    baseline.searchIndex
      ? "junior_conversation_messages_search_idx"
      : undefined,
    baseline.metricRunIdColumn
      ? "junior_conversations.metric_run_id"
      : undefined,
  ].filter((marker): marker is string => marker !== undefined);
  if (postBaselineMarkers.length > 0) {
    throw new Error(
      `Cannot adopt legacy core migration state: post-baseline schema markers are already present: ${postBaselineMarkers.join(", ")}`,
    );
  }

  const migration = metricsComplete ? migrations[1] : migrations[0];
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
