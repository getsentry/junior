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
  id: number;
  /** The migration folder name. Rows from before Drizzle v1 have none. */
  name: string | null;
}

/** Rows of a Drizzle migration table, or undefined when it does not exist. */
export async function readMigrationRecords(
  executor: JuniorSqlMigrationExecutor,
  table: string,
): Promise<MigrationRecord[] | undefined> {
  try {
    // A table from before Drizzle v1 has no name column; to_jsonb reads it
    // when it exists.
    const rows = await executor.query<{
      createdAt: string | null;
      hash: string;
      id: number;
      name: string | null;
    }>(
      `SELECT id, hash, created_at::text AS "createdAt", to_jsonb(m) ->> 'name' AS name FROM ${table} m ORDER BY id`,
    );
    return rows.map((row) => ({
      createdAt: Number(row.createdAt),
      hash: row.hash,
      id: row.id,
      name: row.name,
    }));
  } catch (error) {
    if (isPostgresErrorCode(error, "42P01")) {
      return undefined;
    }
    throw error;
  }
}

const secondOf = (millis: number) => Math.floor(millis / 1000);

// A row from before Drizzle v1 records the migration with its exact time,
// else the one with its SQL hash (the time changed), else the one in the same
// second (the SQL changed, or Drizzle v1 reads the time from a folder name
// with second precision).
const LEGACY_RECORD_MATCHERS: ((
  migration: MigrationMeta,
  record: MigrationRecord,
) => boolean)[] = [
  (migration, record) => record.createdAt === migration.folderMillis,
  (migration, record) => record.hash === migration.hash,
  (migration, record) =>
    secondOf(record.createdAt) === secondOf(migration.folderMillis),
];

/**
 * Match rows from before Drizzle v1 to migrations. Rows that match no
 * migration, such as those of a newer release, do not count. The migrations
 * before the first matched one map to no row: adopting a legacy schema
 * recorded only its newest migration, so they count as applied too.
 */
function matchLegacyRecords<T extends MigrationMeta>(
  migrations: readonly T[],
  records: readonly MigrationRecord[],
): { adopted: T[]; matched: Map<T, MigrationRecord> } {
  const matched = new Map<T, MigrationRecord>();
  let unmatched = [...records];
  for (const matches of LEGACY_RECORD_MATCHERS) {
    unmatched = unmatched.filter((record) => {
      const migration = migrations.find(
        (candidate) => !matched.has(candidate) && matches(candidate, record),
      );
      if (migration) {
        matched.set(migration, record);
      }
      return !migration;
    });
  }
  const first = migrations.findIndex((migration) => matched.has(migration));
  return {
    adopted: first === -1 ? [] : migrations.slice(0, first),
    matched,
  };
}

/**
 * Migrations, in order, that their migration table does not record. A
 * migration that merges after a newer one is still pending. Like Drizzle v1,
 * a row records the migration with its folder name. Rows from before Drizzle
 * v1 match as `matchLegacyRecords` says.
 */
export function pendingMigrations<T extends MigrationMeta>(
  migrations: readonly T[],
  records: readonly MigrationRecord[],
): T[] {
  if (records.some((record) => record.name !== null)) {
    const names = new Set(records.map((record) => record.name));
    return migrations.filter((migration) => !names.has(migration.name ?? null));
  }
  const { adopted, matched } = matchLegacyRecords(migrations, records);
  return migrations.filter(
    (migration) => !matched.has(migration) && !adopted.includes(migration),
  );
}

/**
 * Give a migration table from before Drizzle v1 the columns that v1 reads,
 * and name each row with the migration that it records. Add a row for each
 * legacy-adopted migration, so that every applied migration has a named row
 * and Drizzle's own migrator sees the same pending migrations.
 */
async function upgradeMigrationTable(
  executor: JuniorSqlMigrationExecutor,
  table: string,
  migrations: readonly MigrationMeta[],
): Promise<void> {
  const records = (await readMigrationRecords(executor, table)) ?? [];
  if (records.some((record) => record.name !== null)) {
    return;
  }
  const { adopted, matched } = matchLegacyRecords(migrations, records);
  await executor.transaction(async () => {
    await executor.execute(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS applied_at timestamp with time zone DEFAULT now()`,
    );
    /* oxlint-disable no-await-in-loop -- One small statement per migration, in one transaction. */
    for (const [migration, record] of matched) {
      await executor.execute(
        `UPDATE ${table} SET name = $1, applied_at = NULL WHERE id = $2`,
        [migration.name, record.id],
      );
    }
    for (const migration of adopted) {
      await executor.execute(
        `INSERT INTO ${table} (hash, created_at, name, applied_at) VALUES ($1, $2, $3, NULL)`,
        [migration.hash, migration.folderMillis, migration.name],
      );
    }
    /* oxlint-enable no-await-in-loop */
  });
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
 * Drizzle v1's migration table, upgrades one from before v1 the way v1 does,
 * and applies each migration that it does not record (see
 * `pendingMigrations`), so a migration that merges after a newer one still
 * runs. A migration that waits too long for a lock rolls back and
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
    `CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())`,
  );
  const migrations = readMigrationFiles(config);
  await upgradeMigrationTable(executor, table, migrations);
  const records = (await readMigrationRecords(executor, table)) ?? [];

  /* oxlint-disable no-await-in-loop -- Migrations, and the statements of each, apply in order. */
  for (const migration of pendingMigrations(migrations, records)) {
    const tag = migration.name ?? String(migration.folderMillis);
    const recordApplied = () =>
      executor.execute(
        `INSERT INTO ${table} (hash, created_at, name) VALUES ($1, $2, $3)`,
        [migration.hash, migration.folderMillis, migration.name],
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
        // A migration can hold only comments, such as one that records a
        // Drizzle snapshot and does not change the database.
        for (const statement of migration.sql.filter(sqlOf)) {
          await executor.execute(statement);
        }
        await recordApplied();
      });
    });
  }
  /* oxlint-enable no-await-in-loop */
}
