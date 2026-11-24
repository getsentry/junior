/** SQL schema migrations for durable Junior records. */
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import {
  pendingMigrations,
  readMigrationRecords,
  type MigrationRecord,
} from "@/db/migrate";
import { juniorSqlSchema as schema } from "@/db/schema";

// A schema without the core Drizzle journal must upgrade through this release
// first. Keep this guard.
const CORE_MIGRATION_BRIDGE_VERSION = "0.107.1";
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

interface CoreMigrationState {
  hasJuniorTables: boolean;
  records?: MigrationRecord[];
}

interface CoreMigrationResult {
  existing: number;
  migrated: number;
  scanned: number;
}

/** Read core migration rows and detect existing pre-journal Junior tables. */
async function loadCoreMigrationState(
  executor: JuniorSqlMigrationExecutor,
): Promise<CoreMigrationState> {
  const records = await readMigrationRecords(
    executor,
    `drizzle.${MIGRATIONS_TABLE}`,
  );
  if (records?.length) {
    return { hasJuniorTables: true, records };
  }

  const [tables] = await executor.query<{ hasJuniorTables: boolean }>(`
SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'junior\\_%' ESCAPE '\\'
  ) AS "hasJuniorTables"
`);
  return {
    hasJuniorTables: tables?.hasJuniorTables ?? false,
  };
}

function migrationResult(
  migrations: readonly MigrationMeta[],
  state: CoreMigrationState,
): CoreMigrationResult {
  const migrated = pendingMigrations(migrations, state.records ?? []).length;
  return {
    existing: migrations.length - migrated,
    migrated,
    scanned: migrations.length,
  };
}

/** Reject legacy databases that must first run the bridge release upgrade. */
function assertSupportedMigrationState(state: CoreMigrationState): void {
  if (!state.hasJuniorTables || state.records) {
    return;
  }
  throw new Error(
    `Existing SQL tables have no core Drizzle migration history. Stop old workers, install @sentry/junior@${CORE_MIGRATION_BRIDGE_VERSION}, run \`junior upgrade\`, then restore this version and rerun \`junior upgrade\` before restarting workers.`,
  );
}

export { schema };

/** Apply the packaged Drizzle migrations during `junior upgrade`. */
export async function migrateSchema(
  executor: JuniorSqlMigrationExecutor,
): Promise<CoreMigrationResult> {
  const migrationsFolder = migrationFolder();
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) {
    throw new Error("No core Drizzle migrations were packaged");
  }

  const initialState = await loadCoreMigrationState(executor);
  const initialResult = migrationResult(migrations, initialState);
  if (initialResult.migrated === 0) {
    return initialResult;
  }
  assertSupportedMigrationState(initialState);

  return await executor.withMigrationLock(MIGRATIONS_TABLE, async () => {
    const lockedState = await loadCoreMigrationState(executor);
    const lockedResult = migrationResult(migrations, lockedState);
    if (lockedResult.migrated === 0) {
      return lockedResult;
    }
    assertSupportedMigrationState(lockedState);
    await executor.migrate({
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return lockedResult;
  });
}
