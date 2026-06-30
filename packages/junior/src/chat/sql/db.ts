/**
 * Shared Junior SQL boundary.
 *
 * Feature schemas compose into `juniorSqlSchema`, and feature stores should use
 * Drizzle through `db()`. Raw SQL exists on this executor for schema migration
 * and catalog checks only.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
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
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

export interface JuniorSqlExecutor extends JuniorSqlMigrationExecutor {
  close(): Promise<void>;
}
