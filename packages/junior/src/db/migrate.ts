import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "./db";
import { logWarn } from "@/chat/logging";

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

function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if ("code" in current && current.code === LOCK_NOT_AVAILABLE) {
      return true;
    }
    current = current.cause;
  }
  return false;
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
  while (!(await tryLock())) {
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
  }
}

async function retryOnLockTimeout(
  tag: string,
  apply: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await apply();
      return;
    } catch (error) {
      if (attempt >= LOCK_ATTEMPTS || !isLockTimeout(error)) {
        throw error;
      }
      logWarn("db.migration.lock_timeout", {
        "app.db.migration.tag": tag,
        "app.db.migration.attempt": attempt,
      });
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
}

/**
 * Apply pending Drizzle migrations, each in its own transaction.
 *
 * Drizzle's `migrate()` runs every pending migration in one transaction
 * (drizzle-orm#3249), so locks from earlier migrations stay held while later
 * migrations wait for theirs. That can deadlock with live traffic. This keeps
 * Drizzle's journal table and skip rule, so existing databases are unaffected.
 * A migration that waits too long for a lock rolls back and runs again. A
 * migration that only builds indexes concurrently runs outside a transaction.
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
  const [last] = await executor.query<{ createdAt: string | null }>(
    `SELECT created_at::text AS "createdAt" FROM ${table} ORDER BY created_at DESC LIMIT 1`,
  );
  const appliedAt = Number(last?.createdAt ?? 0);

  for (const migration of readMigrationFiles(config)) {
    if (migration.folderMillis <= appliedAt) {
      continue;
    }
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
}
