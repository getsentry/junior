import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { buildConcurrentIndexes } from "./concurrent-indexes";
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
 * Before each migration, its marked indexes are built concurrently. A
 * migration that waits too long for a lock rolls back and runs again.
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
    await buildConcurrentIndexes(executor, migration);
    await retryOnLockTimeout(String(migration.folderMillis), async () => {
      await executor.transaction(async () => {
        await executor.execute(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        for (const statement of migration.sql) {
          await executor.execute(statement);
        }
        await executor.execute(
          `INSERT INTO ${table} (hash, created_at) VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      });
    });
  }
}
