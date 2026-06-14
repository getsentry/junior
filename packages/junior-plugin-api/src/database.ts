import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

export type PluginDrizzleDatabase = PgDatabase<
  PgQueryResultHKT,
  Record<string, never>
>;

export interface PluginDb {
  delete: PluginDrizzleDatabase["delete"];
  execute(statement: string, params?: readonly unknown[]): Promise<void>;
  insert: PluginDrizzleDatabase["insert"];
  query<T = unknown>(
    statement: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  select: PluginDrizzleDatabase["select"];
  transaction<T>(callback: (tx: PluginDb) => Promise<T>): Promise<T>;
  update: PluginDrizzleDatabase["update"];
}

export type PluginDatabaseConfig = Record<string, never>;
