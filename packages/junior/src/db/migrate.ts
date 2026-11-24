import {
  readMigrationFiles,
  type MigrationConfig,
  type MigrationMeta,
} from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "./db";
import { logWarn } from "@/chat/logging";
import { isPostgresErrorCode } from "./postgres-error";

// A statement such as ADD COLUMN is instant once it has its table lock. While
// it waits for that lock behind an open app transaction, every later query on
// the table waits behind it. Give up the wait early, then run the migration's
// transaction again after a pause.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_DELAY_MS = 5_000;
// Postgres `lock_not_available`, raised when `lock_timeout` expires.
const LOCK_NOT_AVAILABLE = "55P03";
const MIGRATION_LOCK_POLL_MS = 1_000;
const CONCURRENT_STATEMENT =
  /^(?:CREATE (?:UNIQUE )?INDEX|DROP INDEX|REINDEX)\b[^;]*\bCONCURRENTLY\b/i;
const CONCURRENT_INDEX =
  /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS "([a-z0-9_]+)" /i;

/** One row of a Drizzle migration table. */
export interface MigrationRecord {
  createdAt: number;
  hash: string;
}

/** Rows of a Drizzle migration table, or undefined when it does not exist. */
export async function readMigrationRecords(
  executor: JuniorSqlMigrationExecutor,
  table: string,
): Promise<MigrationRecord[] | undefined> {
  try {
    const rows = await executor.query<{
      createdAt: string | null;
      hash: string;
    }>(`SELECT hash, created_at::text AS "createdAt" FROM ${table}`);
    return rows.map((row) => ({
      createdAt: Number(row.createdAt),
      hash: row.hash,
    }));
  } catch (error) {
    if (isPostgresErrorCode(error, "42P01")) {
      return undefined;
    }
    throw error;
  }
}

const secondOf = (millis: number) => Math.floor(millis / 1000);

// A row records the migration with its exact time, else the one with its SQL
// hash (the time changed), else the one in the same second (the SQL changed,
// or Drizzle v1 reads the time from a folder name with second precision).
const RECORD_MATCHERS: ((
  migration: MigrationMeta,
  record: MigrationRecord,
) => boolean)[] = [
  (migration, record) => record.createdAt === migration.folderMillis,
  (migration, record) => record.hash === migration.hash,
  (migration, record) =>
    secondOf(record.createdAt) === secondOf(migration.folderMillis),
];

/**
 * Migrations, in order, that no row of their migration table records.
 *
 * A migration that merges after a newer one is still pending. The migrations
 * before the first recorded one are not: adopting a legacy schema records
 * only its newest migration. Rows that match no migration, such as those of a
 * newer release, do not count.
 */
export function pendingMigrations<T extends MigrationMeta>(
  migrations: readonly T[],
  records: readonly MigrationRecord[],
): T[] {
  const recorded = new Set<T>();
  let unmatched = [...records];
  for (const matches of RECORD_MATCHERS) {
    unmatched = unmatched.filter((record) => {
      const migration = migrations.find(
        (candidate) => !recorded.has(candidate) && matches(candidate, record),
      );
      if (migration) {
        recorded.add(migration);
      }
      return !migration;
    });
  }
  const first = migrations.findIndex((migration) => recorded.has(migration));
  return first === -1
    ? [...migrations]
    : migrations.filter(
        (migration, index) => index > first && !recorded.has(migration),
      );
}

/** Statement text without its leading comment lines. */
function sqlOf(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

/**
 * Index builds of a migration that only builds indexes concurrently, or
 * undefined for a migration that runs in a transaction.
 */
function concurrentIndexes(
  tag: string,
  statements: readonly string[],
): { name: string; statement: string }[] | undefined {
  const sql = statements.map(sqlOf).filter(Boolean);
  if (!sql.some((statement) => CONCURRENT_STATEMENT.test(statement))) {
    return undefined;
  }
  return sql.map((statement) => {
    const name = CONCURRENT_INDEX.exec(statement)?.[1];
    if (!name) {
      throw new Error(
        `Migration ${tag}: a migration that uses CONCURRENTLY must contain only CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "name" statements.`,
      );
    }
    return { name, statement };
  });
}

/**
 * Wait for the migration lock by polling `pg_try_advisory_lock`. A session
 * blocked in `pg_advisory_lock` holds a snapshot, and `CREATE INDEX
 * CONCURRENTLY` waits for every older snapshot, so a second migrator that
 * blocked there would deadlock with the build of the first.
 */
export async function waitForMigrationLock(
  tryLock: () => Promise<boolean>,
): Promise<void> {
  /* oxlint-disable no-await-in-loop -- Poll until the lock is free. */
  while (!(await tryLock())) {
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
  }
  /* oxlint-enable no-await-in-loop */
}

async function retryOnLockTimeout(
  tag: string,
  apply: () => Promise<void>,
): Promise<void> {
  /* oxlint-disable no-await-in-loop -- Retry only after the attempt before fails. */
  for (let attempt = 1; ; attempt += 1) {
    try {
      await apply();
      return;
    } catch (error) {
      if (
        attempt >= LOCK_ATTEMPTS ||
        !isPostgresErrorCode(error, LOCK_NOT_AVAILABLE)
      ) {
        throw error;
      }
      logWarn("db.migration.lock_timeout", {
        "app.db.migration.tag": tag,
        "app.db.migration.attempt": attempt,
      });
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * Apply pending Drizzle migrations, each in its own transaction.
 *
 * Drizzle's `migrate()` runs every pending migration in one transaction
 * (drizzle-orm#3249), so locks from earlier migrations stay held while later
 * migrations wait for theirs. That can deadlock with live traffic. This keeps
 * Drizzle's migration table and applies each migration that it does not
 * record (see `pendingMigrations`), so a migration that merges after a newer
 * one still runs. A migration that waits too long for a lock rolls back and
 * runs again. A migration that only builds indexes concurrently runs outside a
 * transaction.
 */
export async function applyMigrations(
  executor: JuniorSqlMigrationExecutor,
  config: MigrationConfig,
): Promise<void> {
  const schema = config.migrationsSchema ?? "drizzle";
  const table = `"${schema}"."${config.migrationsTable ?? "__drizzle_migrations"}"`;
  await executor.execute(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await executor.execute(
    `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const records = (await readMigrationRecords(executor, table)) ?? [];

  /* oxlint-disable no-await-in-loop -- Migrations, and the statements of each, apply in order. */
  for (const migration of pendingMigrations(
    readMigrationFiles(config),
    records,
  )) {
    const tag = String(migration.folderMillis);
    const recordApplied = () =>
      executor.execute(
        `INSERT INTO ${table} (hash, created_at) VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    const indexes = concurrentIndexes(tag, migration.sql);
    if (indexes) {
      // CONCURRENTLY cannot run in a transaction. Its lock does not block app
      // reads or writes, so its waits need no lock_timeout. A failed build
      // leaves an invalid index; drop it so the next run builds it again.
      for (const { name, statement } of indexes) {
        const [state] = await executor.query<{ usable: boolean }>(
          `SELECT indisvalid AND indisready AS usable FROM pg_index WHERE indexrelid = to_regclass($1)`,
          [name],
        );
        if (state && !state.usable) {
          await executor.execute(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
        }
        await executor.execute(statement);
      }
      await recordApplied();
      continue;
    }
    await retryOnLockTimeout(tag, async () => {
      await executor.transaction(async () => {
        await executor.execute(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        for (const statement of migration.sql) {
          await executor.execute(statement);
        }
        await recordApplied();
      });
    });
  }
  /* oxlint-enable no-await-in-loop */
}
