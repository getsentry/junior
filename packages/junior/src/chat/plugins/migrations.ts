import { createHash } from "node:crypto";
import {
  resolveMigrations,
  runMigrationJournal,
  type MigrationContextV1,
  type MigrationStateV1,
  type ResolvedMigration,
  type TypeScriptMigrationLoader,
} from "@sentry/junior-migrations";
import type { StateAdapter } from "chat";
import type { JuniorSqlMigrationExecutor } from "@/db/db";

interface PluginMigrationRoot {
  /** Absolute path to the plugin's Drizzle migrations directory. */
  dir: string;
  pluginName: string;
}

type PluginMigrationResult = {
  existing: number;
  migrated: number;
  scanned: number;
  skipped?: number;
};

type PluginMigrationOptions =
  | { mode?: "sql" }
  | {
      loadTypeScript: TypeScriptMigrationLoader;
      log?: MigrationContextV1["log"];
      mode: "all";
      stateAdapter: StateAdapter;
    };

const LEGACY_SCHEDULER_BASELINE_HASH =
  "d1d2f712181dd3a0557808f0fc67fd0722691d25f4c8cfb816b77c71d19e1e42";

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

function adoptedMigration(
  migrations: readonly ResolvedMigration[],
  legacyHashes: ReadonlySet<string>,
  pluginName: string,
): ResolvedMigration | undefined {
  let adopted: ResolvedMigration | undefined;
  for (const migration of migrations) {
    if (migration.kind !== "sql" || !legacyHashes.has(migration.hash)) {
      break;
    }
    adopted = migration;
  }
  if (
    !adopted &&
    pluginName === "scheduler" &&
    legacyHashes.has(LEGACY_SCHEDULER_BASELINE_HASH)
  ) {
    return migrations[0];
  }
  return adopted;
}

async function adoptLegacyMigrationState(args: {
  executor: JuniorSqlMigrationExecutor;
  migrations: readonly ResolvedMigration[];
  pluginName: string;
  table: string;
}): Promise<void> {
  const [exists] = await args.executor.query<{ tableName: string | null }>(
    `SELECT to_regclass($1)::text AS "tableName"`,
    [`drizzle.${args.table}`],
  );
  if (exists?.tableName) {
    return;
  }
  const legacyHashes = await legacyMigrationHashes(
    args.executor,
    args.pluginName,
  );
  const migration = adoptedMigration(
    args.migrations,
    legacyHashes,
    args.pluginName,
  );
  if (!migration) {
    return;
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
      [migration.hash, migration.when],
    );
  });
}

function migrationState(stateAdapter: StateAdapter): MigrationStateV1 {
  return {
    acquireLock: async (threadId, ttlMs) =>
      await stateAdapter.acquireLock(threadId, ttlMs),
    appendToList: async (key, value, options) => {
      await stateAdapter.appendToList(key, value, options);
    },
    connect: async () => {
      await stateAdapter.connect();
    },
    delete: async (key) => {
      await stateAdapter.delete(key);
    },
    get: async (key) => await stateAdapter.get<unknown>(key),
    getList: async (key) => await stateAdapter.getList(key),
    releaseLock: async (lock) => {
      await stateAdapter.releaseLock(lock);
    },
    set: async (key, value, ttlMs) => {
      await stateAdapter.set(key, value, ttlMs);
    },
    setIfNotExists: async (key, value, ttlMs) =>
      await stateAdapter.setIfNotExists(key, value, ttlMs),
  };
}

/** Apply enabled plugins' mixed migrations in plugin-name and journal order. */
export async function migratePluginSchemas(
  executor: JuniorSqlMigrationExecutor,
  roots: readonly PluginMigrationRoot[],
  options: PluginMigrationOptions = { mode: "sql" },
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
    const migrations = await resolveMigrations(root.dir);
    const table = migrationTable(root.pluginName);
    const runAll = options.mode === "all";
    const baseOptions = {
      beforeRun: async () => {
        await adoptLegacyMigrationState({
          executor,
          migrations,
          pluginName: root.pluginName,
          table,
        });
      },
      executor,
      migrationsFolder: root.dir,
      migrationsTable: table,
    };
    const pluginResult = runAll
      ? await runMigrationJournal({
          ...baseOptions,
          createContext: ({ progress }): MigrationContextV1 => ({
            database: executor,
            log: options.log ?? (() => {}),
            progress,
            state: migrationState(options.stateAdapter),
          }),
          loadTypeScript: options.loadTypeScript,
          mode: "all",
        })
      : await runMigrationJournal({ ...baseOptions, mode: "sql" });
    result.scanned += pluginResult.scanned;
    result.existing += pluginResult.existing;
    result.migrated += pluginResult.migrated;
    if (pluginResult.skipped > 0) {
      result.skipped = (result.skipped ?? 0) + pluginResult.skipped;
    }
  }
  return result;
}
