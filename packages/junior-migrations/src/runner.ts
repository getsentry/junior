import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  MigrationContextV1,
  MigrationDatabaseAdapter,
  MigrationJournalExecutor,
  MigrationJsonValue,
  MigrationRunResult,
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

function migrationJsonValue(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): MigrationJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error(`${label} must contain only finite JSON numbers`);
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must be JSON-compatible`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} must not contain circular references`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => migrationJsonValue(item, label, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain only plain JSON objects`);
  }
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      migrationJsonValue(item, label, seen),
    ]),
  );
  seen.delete(value);
  return result;
}

interface RunMigrationJournalBaseOptions {
  beforeRun?: () => Promise<void>;
  executor: MigrationJournalExecutor;
  migrationsFolder: string;
  migrationsTable: string;
}

interface RunAllMigrationJournalOptions extends RunMigrationJournalBaseOptions {
  createContext: (args: {
    migration: ResolvedMigration;
    progress: MigrationContextV1["progress"];
  }) => MigrationContextV1 | Promise<MigrationContextV1>;
  loadTypeScript: TypeScriptMigrationLoader;
  mode?: "all";
}

interface RunSchemaBootstrapMigrationJournalOptions extends RunMigrationJournalBaseOptions {
  createContext?: never;
  loadTypeScript?: never;
  mode: "schema-bootstrap";
}

/** Host capabilities and execution mode for one mixed migration journal. */
export type RunMigrationJournalOptions =
  | RunAllMigrationJournalOptions
  | RunSchemaBootstrapMigrationJournalOptions;

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
  executor: MigrationJournalExecutor,
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
  executor: MigrationJournalExecutor,
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
  executor: MigrationJournalExecutor;
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
  executor: MigrationJournalExecutor;
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
  executor: MigrationDatabaseAdapter;
  loadTypeScript: TypeScriptMigrationLoader;
  migration: ResolvedMigration;
  row: MigrationRow | undefined;
  table: string;
}): Promise<void> {
  const qualified = qualifiedTable(args.table);
  const sourceChanged =
    args.row !== undefined && args.row.hash !== args.migration.hash;
  if (
    args.row &&
    sourceChanged &&
    args.row.status !== "failed" &&
    args.row.status !== "running"
  ) {
    throw new Error(`Migration ${args.migration.tag} changed after it started`);
  }
  if (args.row) {
    if (sourceChanged) {
      await args.executor.execute(
        `UPDATE ${qualified}
         SET hash = $1, name = $2, kind = 'typescript', status = 'running',
             progress = NULL, result = NULL, started_at = NOW(), completed_at = NULL
         WHERE created_at = $3`,
        [args.migration.hash, args.migration.tag, args.migration.when],
      );
    } else {
      await args.executor.execute(
        `UPDATE ${qualified}
         SET name = $1, kind = 'typescript', status = 'running', started_at = NOW()
         WHERE created_at = $2`,
        [args.migration.tag, args.migration.when],
      );
    }
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
      return current?.progress == null
        ? undefined
        : migrationJsonValue(current.progress, "Migration progress");
    },
    async save(value) {
      const progressValue = migrationJsonValue(value, "Migration progress");
      await args.executor.execute(
        `UPDATE ${qualified} SET progress = $1, status = 'running' WHERE created_at = $2`,
        [progressValue, args.migration.when],
      );
    },
  };
  try {
    const context = await args.createContext({
      migration: args.migration,
      progress,
    });
    const currentSource = await readFile(args.migration.path, "utf8");
    const currentHash = createHash("sha256")
      .update(currentSource)
      .digest("hex");
    if (currentHash !== args.migration.hash) {
      throw new Error(`Migration ${args.migration.tag} changed before loading`);
    }
    const migration = migrationV1(
      await args.loadTypeScript(args.migration.path),
      args.migration.tag,
    );
    const result = await migration.up(context);
    const resultValue =
      result === undefined
        ? null
        : migrationJsonValue(result, "Migration result");
    await args.executor.execute(
      `UPDATE ${qualified}
       SET status = 'completed', result = $1, completed_at = NOW()
       WHERE created_at = $2`,
      [resultValue, args.migration.when],
    );
  } catch (error) {
    try {
      await args.executor.execute(
        `UPDATE ${qualified} SET status = 'failed' WHERE created_at = $1`,
        [args.migration.when],
      );
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        `Migration ${args.migration.tag} failed and its failure status could not be persisted`,
      );
    }
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
        if (
          row &&
          row.hash !== migration.hash &&
          !(
            migration.kind === "typescript" &&
            (row.status === "failed" || row.status === "running")
          )
        ) {
          throw new Error(
            `Migration ${migration.tag} changed after it started`,
          );
        }
        if (row?.status === "completed" || (row && row.status === null)) {
          result.existing += 1;
          continue;
        }
        if (mode === "schema-bootstrap" && migration.kind === "typescript") {
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
