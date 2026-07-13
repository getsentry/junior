import type {
  MigrationContextV1,
  MigrationRunResult,
  MigrationSqlExecutor,
  MigrationV1,
  ResolvedMigration,
  TypeScriptMigrationLoader,
} from "./types";
import { resolveMigrations } from "./journal";

interface MigrationRow {
  createdAt: string;
  hash: string;
  progress: unknown;
  status: string | null;
}

interface RunMigrationJournalBaseOptions {
  beforeRun?: () => Promise<void>;
  executor: MigrationSqlExecutor;
  migrationsFolder: string;
  migrationsTable: string;
}

interface RunAllMigrationJournalOptions extends RunMigrationJournalBaseOptions {
  createContext: (args: {
    migration: ResolvedMigration;
    progress: MigrationContextV1["progress"];
  }) => MigrationContextV1;
  loadTypeScript: TypeScriptMigrationLoader;
  mode?: "all";
}

interface RunSqlMigrationJournalOptions extends RunMigrationJournalBaseOptions {
  createContext?: never;
  loadTypeScript?: never;
  mode: "sql";
}

/** Host capabilities and execution mode for one mixed migration journal. */
export type RunMigrationJournalOptions =
  | RunAllMigrationJournalOptions
  | RunSqlMigrationJournalOptions;

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid migration table identifier: ${value}`);
  }
  return value;
}

function qualifiedTable(table: string): string {
  return `drizzle.${identifier(table)}`;
}

async function ensureMigrationTable(
  executor: MigrationSqlExecutor,
  table: string,
): Promise<void> {
  const qualified = qualifiedTable(table);
  await executor.execute("CREATE SCHEMA IF NOT EXISTS drizzle");
  await executor.execute(`
CREATE TABLE IF NOT EXISTS ${qualified} (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
)
`);
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS name TEXT`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS kind TEXT`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS status TEXT`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS progress JSONB`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS result JSONB`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
  );
  await executor.execute(
    `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
  );
}

async function migrationRows(
  executor: MigrationSqlExecutor,
  table: string,
): Promise<Map<number, MigrationRow>> {
  const rows = await executor.query<MigrationRow>(`
SELECT
  created_at::text AS "createdAt",
  hash,
  progress,
  status
FROM ${qualifiedTable(table)}
WHERE created_at IS NOT NULL
ORDER BY created_at ASC, id ASC
`);
  return new Map(rows.map((row) => [Number(row.createdAt), row]));
}

async function adoptLegacySqlPrefix(args: {
  executor: MigrationSqlExecutor;
  migrations: readonly ResolvedMigration[];
  rows: Map<number, MigrationRow>;
  table: string;
}): Promise<void> {
  const latestAppliedAt = Math.max(
    ...args.rows.keys(),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(latestAppliedAt)) {
    return;
  }
  for (const migration of args.migrations) {
    if (
      migration.when >= latestAppliedAt ||
      migration.kind !== "sql" ||
      args.rows.has(migration.when)
    ) {
      continue;
    }
    await args.executor.execute(
      `INSERT INTO ${qualifiedTable(args.table)}
       (hash, created_at, name, kind, status, completed_at)
       VALUES ($1, $2, $3, 'sql', 'completed', NOW())`,
      [migration.hash, migration.when, migration.tag],
    );
  }
}

function sqlStatements(migration: ResolvedMigration): string[] {
  return migration.source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function migrationV1(value: unknown, tag: string): MigrationV1 {
  const candidate =
    typeof value === "object" && value !== null && "default" in value
      ? (value as { default?: unknown }).default
      : value;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    (candidate as { apiVersion?: unknown }).apiVersion !== 1 ||
    typeof (candidate as { up?: unknown }).up !== "function"
  ) {
    throw new Error(`TypeScript migration ${tag} does not export MigrationV1`);
  }
  return candidate as MigrationV1;
}

async function runSqlMigration(args: {
  executor: MigrationSqlExecutor;
  migration: ResolvedMigration;
  table: string;
}): Promise<void> {
  await args.executor.transaction(async () => {
    for (const statement of sqlStatements(args.migration)) {
      await args.executor.execute(statement);
    }
    await args.executor.execute(
      `INSERT INTO ${qualifiedTable(args.table)}
       (hash, created_at, name, kind, status, started_at, completed_at)
       VALUES ($1, $2, $3, 'sql', 'completed', NOW(), NOW())`,
      [args.migration.hash, args.migration.when, args.migration.tag],
    );
  });
}

async function runTypeScriptMigration(args: {
  createContext: RunAllMigrationJournalOptions["createContext"];
  executor: MigrationSqlExecutor;
  loadTypeScript: TypeScriptMigrationLoader;
  migration: ResolvedMigration;
  row: MigrationRow | undefined;
  table: string;
}): Promise<void> {
  const qualified = qualifiedTable(args.table);
  if (args.row && args.row.hash !== args.migration.hash) {
    throw new Error(`Migration ${args.migration.tag} changed after it started`);
  }
  if (args.row) {
    await args.executor.execute(
      `UPDATE ${qualified}
       SET name = $1, kind = 'typescript', status = 'running', started_at = NOW()
       WHERE created_at = $2`,
      [args.migration.tag, args.migration.when],
    );
  } else {
    await args.executor.execute(
      `INSERT INTO ${qualified}
       (hash, created_at, name, kind, status, started_at)
       VALUES ($1, $2, $3, 'typescript', 'running', NOW())`,
      [args.migration.hash, args.migration.when, args.migration.tag],
    );
  }
  const progress: MigrationContextV1["progress"] = {
    async load() {
      const [current] = await args.executor.query<{
        progress: Awaited<ReturnType<MigrationContextV1["progress"]["load"]>>;
      }>(`SELECT progress FROM ${qualified} WHERE created_at = $1 LIMIT 1`, [
        args.migration.when,
      ]);
      return current?.progress ?? undefined;
    },
    async save(value) {
      await args.executor.execute(
        `UPDATE ${qualified} SET progress = $1, status = 'running' WHERE created_at = $2`,
        [value, args.migration.when],
      );
    },
  };
  try {
    const context = args.createContext({ migration: args.migration, progress });
    const migration = migrationV1(
      await args.loadTypeScript(args.migration.path),
      args.migration.tag,
    );
    const result = await migration.up(context);
    await args.executor.execute(
      `UPDATE ${qualified}
       SET status = 'completed', result = $1, completed_at = NOW()
       WHERE created_at = $2`,
      [result ?? null, args.migration.when],
    );
  } catch (error) {
    await args.executor.execute(
      `UPDATE ${qualified} SET status = 'failed' WHERE created_at = $1`,
      [args.migration.when],
    );
    throw error;
  }
}

/** Execute one mixed Drizzle journal with exact SQL and TypeScript entry tracking. */
export async function runMigrationJournal(
  options: RunMigrationJournalOptions,
): Promise<MigrationRunResult> {
  const migrations = await resolveMigrations(options.migrationsFolder);
  const mode = options.mode ?? "all";
  return await options.executor.withMigrationLock(
    options.migrationsTable,
    async () => {
      await options.beforeRun?.();
      await ensureMigrationTable(options.executor, options.migrationsTable);
      let rows = await migrationRows(options.executor, options.migrationsTable);
      await adoptLegacySqlPrefix({
        executor: options.executor,
        migrations,
        rows,
        table: options.migrationsTable,
      });
      rows = await migrationRows(options.executor, options.migrationsTable);
      const result: MigrationRunResult = {
        existing: 0,
        migrated: 0,
        scanned: migrations.length,
        skipped: 0,
      };
      for (const migration of migrations) {
        const row = rows.get(migration.when);
        if (row && row.hash !== migration.hash) {
          throw new Error(
            `Migration ${migration.tag} changed after it started`,
          );
        }
        if (row?.status === "completed" || (row && row.status === null)) {
          result.existing += 1;
          continue;
        }
        if (mode === "sql" && migration.kind === "typescript") {
          result.skipped += 1;
          continue;
        }
        if (migration.kind === "sql") {
          await runSqlMigration({
            executor: options.executor,
            migration,
            table: options.migrationsTable,
          });
        } else {
          if (!options.createContext || !options.loadTypeScript) {
            throw new Error(
              `TypeScript migration ${migration.tag} requires a loader and context`,
            );
          }
          await runTypeScriptMigration({
            createContext: options.createContext,
            executor: options.executor,
            loadTypeScript: options.loadTypeScript,
            migration,
            row,
            table: options.migrationsTable,
          });
        }
        result.migrated += 1;
      }
      return result;
    },
  );
}
