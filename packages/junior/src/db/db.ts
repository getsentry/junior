/**
 * Shared Junior SQL boundary.
 *
 * Feature schemas compose into `juniorSqlSchema`, and feature stores should use
 * Drizzle through `db()`. Raw SQL exists on this executor for schema migration,
 * catalog checks, and the opt-in `runOperatorSql` tool only.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { MigrationConfig } from "drizzle-orm/migrator";
import type { juniorSqlSchema } from "./schema";

export type JuniorDatabase = PgDatabase<
  PgQueryResultHKT,
  typeof juniorSqlSchema
>;

export interface JuniorSqlDatabase {
  db(): JuniorDatabase;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  withLock<T>(lockName: string, callback: () => Promise<T>): Promise<T>;
}

export interface JuniorSqlMigrationExecutor extends JuniorSqlDatabase {
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  migrate(config: MigrationConfig): Promise<void>;
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  /** Serialize writes to one Drizzle migration journal. */
  withMigrationLock<T>(
    migrationTable: string,
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface JuniorSqlExecutor extends JuniorSqlMigrationExecutor {
  close(): Promise<void>;
  /**
   * Run exactly one caller-written statement on its own connection, then
   * discard that connection. Session state such as `BEGIN` or `SET` cannot
   * reach later pool queries, and statement lists fail instead of running.
   */
  queryIsolated<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}
