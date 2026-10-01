/** SQL schema migrations for durable Junior records. */
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { isPostgresErrorCode } from "@/db/postgres-error";
import { juniorSqlSchema as schema } from "@/db/schema";

const CORE_MIGRATION_BRIDGE_VERSION = "0.107.1";
const MIGRATIONS_TABLE = "__drizzle_junior_core";
/** Postgres extensions the core schema needs. Memory owns both. */
const REQUIRED_EXTENSIONS = ["btree_gin", "vector"] as const;

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
  appliedAt?: number;
  hasJuniorTables: boolean;
}

interface CoreMigrationResult {
  existing: number;
  migrated: number;
  scanned: number;
}

/** Read core journal progress and detect existing pre-journal Junior tables. */
async function loadCoreMigrationState(
  executor: JuniorSqlMigrationExecutor,
): Promise<CoreMigrationState> {
  try {
    const [migration] = await executor.query<{ appliedAt: string | null }>(`
SELECT created_at::text AS "appliedAt"
FROM drizzle.__drizzle_junior_core
ORDER BY created_at DESC
LIMIT 1
`);
    if (migration?.appliedAt !== null && migration?.appliedAt !== undefined) {
      return {
        appliedAt: Number(migration.appliedAt),
        hasJuniorTables: true,
      };
    }
  } catch (error) {
    if (!isPostgresErrorCode(error, "42P01")) {
      throw error;
    }
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

function isCurrentMigrationState(
  state: CoreMigrationState,
  latestMigrationAt: number,
): boolean {
  return state.appliedAt !== undefined && state.appliedAt >= latestMigrationAt;
}

function migrationResult(
  migrations: readonly MigrationMeta[],
  state: CoreMigrationState,
): CoreMigrationResult {
  const appliedAt = state.appliedAt;
  const existing =
    appliedAt === undefined
      ? 0
      : migrations.filter((migration) => migration.folderMillis <= appliedAt)
          .length;
  return {
    existing,
    migrated: migrations.length - existing,
    scanned: migrations.length,
  };
}

/** Reject legacy databases that must first run the bridge release upgrade. */
function assertSupportedMigrationState(state: CoreMigrationState): void {
  if (!state.hasJuniorTables || state.appliedAt !== undefined) {
    return;
  }
  throw new Error(
    `Existing Junior SQL tables have no core Drizzle migration history. Stop old Junior workers, install @sentry/junior@${CORE_MIGRATION_BRIDGE_VERSION}, run \`junior upgrade\`, then restore this Junior version and rerun \`junior upgrade\` before restarting workers.`,
  );
}

/** Enable required extensions, or stop with an operator prerequisite error. */
async function enableRequiredExtensions(
  executor: JuniorSqlMigrationExecutor,
): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS) {
    try {
      await executor.execute(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    } catch (error) {
      throw new Error(
        `Junior requires the Postgres extensions ${REQUIRED_EXTENSIONS.join(" and ")}, but this database could not enable "${extension}". Install pgvector and the btree_gin contrib extension on the database server, or enable them as a privileged user, then rerun \`junior upgrade\`.`,
        { cause: error },
      );
    }
  }
}

export { schema };

/** Apply the packaged Drizzle migrations during `junior upgrade`. */
export async function migrateSchema(
  executor: JuniorSqlMigrationExecutor,
): Promise<CoreMigrationResult> {
  const migrationsFolder = migrationFolder();
  const migrations = readMigrationFiles({ migrationsFolder });
  const latestMigration = migrations.at(-1);
  if (!latestMigration) {
    throw new Error("No core Drizzle migrations were packaged");
  }

  const initialState = await loadCoreMigrationState(executor);
  if (isCurrentMigrationState(initialState, latestMigration.folderMillis)) {
    return migrationResult(migrations, initialState);
  }
  assertSupportedMigrationState(initialState);

  return await executor.withMigrationLock(MIGRATIONS_TABLE, async () => {
    const lockedState = await loadCoreMigrationState(executor);
    if (isCurrentMigrationState(lockedState, latestMigration.folderMillis)) {
      return migrationResult(migrations, lockedState);
    }
    assertSupportedMigrationState(lockedState);
    await enableRequiredExtensions(executor);
    await executor.migrate({
      migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return migrationResult(migrations, lockedState);
  });
}
