/** SQL schema migrations for durable Junior records. */
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runMigrationJournal,
  type MigrationContextV1,
  type MigrationRunResult,
  type TypeScriptMigrationLoader,
} from "@sentry/junior-migrations";
import type { StateAdapter } from "chat";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import type { JuniorSqlMigrationExecutor } from "@/db/db";
import { isPostgresErrorCode } from "@/db/postgres-error";
import { juniorSqlSchema as schema } from "@/db/schema";

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
  appliedAt?: number;
  hasJuniorTables: boolean;
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

/** Reject legacy databases that must first run the bridge release upgrade. */
function assertSupportedMigrationState(state: CoreMigrationState): void {
  if (!state.hasJuniorTables || state.appliedAt !== undefined) {
    return;
  }
  throw new Error(
    `Existing Junior SQL tables have no core Drizzle migration history. Stop old Junior workers, install @sentry/junior@${CORE_MIGRATION_BRIDGE_VERSION}, run \`junior upgrade\`, then restore this Junior version and rerun \`junior upgrade\` before restarting workers.`,
  );
}

export type MigrateSchemaOptions =
  | { mode: "schema-bootstrap" }
  | {
      loadTypeScript: TypeScriptMigrationLoader;
      log?: MigrationContextV1["log"];
      mode: "all";
      redisStateAdapter?: RedisStateAdapter;
      stateAdapter: StateAdapter;
    };

export { schema };

/** Apply all migrations, or bootstrap an empty test database to the latest schema. */
export async function migrateSchema(
  executor: JuniorSqlMigrationExecutor,
  options: MigrateSchemaOptions = { mode: "schema-bootstrap" },
): Promise<MigrationRunResult> {
  const migrationsFolder = migrationFolder();
  const runAll = options.mode === "all";
  const baseOptions = {
    beforeRun: async () => {
      assertSupportedMigrationState(await loadCoreMigrationState(executor));
    },
    executor,
    migrationsFolder,
    migrationsTable: MIGRATIONS_TABLE,
  };
  if (!runAll) {
    return await runMigrationJournal({
      ...baseOptions,
      mode: "schema-bootstrap",
    });
  }
  return await runMigrationJournal({
    ...baseOptions,
    createContext: ({ progress }): MigrationContextV1 => ({
      database: executor,
      log: options.log ?? (() => {}),
      progress,
      ...(options.redisStateAdapter
        ? {
            redis: {
              sendCommand: async <T>(args: readonly string[]) =>
                await options
                  .redisStateAdapter!.getClient()
                  .sendCommand<T>([...args]),
            },
          }
        : {}),
      state: options.stateAdapter,
    }),
    loadTypeScript: options.loadTypeScript,
    mode: "all",
  });
}
