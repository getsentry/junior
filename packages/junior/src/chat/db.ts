import { getAppContext } from "@/app/context";
import type { ChatConfig } from "@/chat/config";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import type { ConversationEventStore } from "@/chat/conversations/history";
import { createSqlConversationMessageSearchStore } from "@/chat/conversations/sql/message-search";
import type { ConversationMessageSearchStore } from "@/chat/conversations/message-search";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";

/**
 * Build the SQL executor of an app context. It opens its pool on first use.
 * After `close`, the next use opens a new pool.
 */
export function createAppSql(config: ChatConfig["sql"]): JuniorSqlExecutor {
  let current: JuniorSqlExecutor | undefined;
  const open = (): JuniorSqlExecutor =>
    (current ??= createJuniorSqlExecutor({
      connectionString: config.databaseUrl,
      driver: config.driver,
      statementTimeoutMs: config.statementTimeoutMs,
    }));
  return {
    close: async () => {
      const previous = current;
      current = undefined;
      await previous?.close();
    },
    db: () => open().db(),
    execute: (statement, params) => open().execute(statement, params),
    migrate: (migration) => open().migrate(migration),
    query: <T>(statement: string, params?: readonly unknown[]) =>
      open().query<T>(statement, params),
    queryIsolated: <T>(statement: string, params?: readonly unknown[]) =>
      open().queryIsolated<T>(statement, params),
    transaction: (callback) => open().transaction(callback),
    withLock: (lockName, callback) => open().withLock(lockName, callback),
    withMigrationLock: (migrationTable, callback) =>
      open().withMigrationLock(migrationTable, callback),
  };
}

/** The SQL-backed stores of an app context, built once on its executor. */
export interface AppStores {
  conversations: ConversationStore;
  events: ConversationEventStore;
  search: ConversationMessageSearchStore;
}

/** Build the SQL-backed stores of an app context. */
export function createAppStores(sql: JuniorSqlExecutor): AppStores {
  return {
    conversations: createSqlStore(sql),
    events: createSqlConversationEventStore(sql),
    search: createSqlConversationMessageSearchStore(sql),
  };
}

/** Return the app SQL executor for SQL-specific queries and transactions. */
export function getSqlExecutor(): JuniorSqlExecutor {
  return getAppContext().sql;
}

/** Return the app Drizzle database. */
export function getDb(): JuniorDatabase {
  return getSqlExecutor().db();
}

/** Return the SQL-backed conversation store. */
export function getConversationStore(): ConversationStore {
  return getAppContext().stores.conversations;
}

/** Return the canonical SQL-backed conversation event store. */
export function getConversationEventStore(): ConversationEventStore {
  return getAppContext().stores.events;
}

/** Return the SQL-backed public provider-tenant conversation search store. */
export function getConversationMessageSearchStore(): ConversationMessageSearchStore {
  return getAppContext().stores.search;
}

/** Close the app SQL pool when it has been opened. */
export async function closeDb(): Promise<void> {
  await getSqlExecutor().close();
}
