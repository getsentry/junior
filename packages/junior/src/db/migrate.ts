import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import type { JuniorSqlMigrationExecutor } from "./db";

/**
 * Apply pending Drizzle migrations, each in its own transaction.
 *
 * Drizzle's `migrate()` runs every pending migration in one transaction
 * (drizzle-orm#3249), so locks from earlier migrations stay held while later
 * migrations wait for theirs. That can deadlock with live traffic. This keeps
 * Drizzle's journal table and skip rule, so existing databases are unaffected.
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
    await executor.transaction(async () => {
      for (const statement of migration.sql) {
        await executor.execute(statement);
      }
      await executor.execute(
        `INSERT INTO ${table} (hash, created_at) VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    });
  }
}
