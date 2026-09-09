import { getChatConfig, type SqlDriver } from "@/chat/config";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import type { ConversationEventStore } from "@/chat/conversations/history";
import { createSqlConversationMessageSearchStore } from "@/chat/conversations/sql/message-search";
import type { ConversationMessageSearchStore } from "@/chat/conversations/message-search";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";

let current:
  | {
      databaseUrl: string;
      db: JuniorSqlExecutor;
      driver: SqlDriver;
      statementTimeoutMs: number | false;
      store: ConversationStore;
      eventStore: ConversationEventStore;
      searchStore: ConversationMessageSearchStore;
    }
  | undefined;

function createDb(args: {
  databaseUrl: string;
  driver: SqlDriver;
  statementTimeoutMs: number | false;
}): JuniorSqlExecutor {
  return createJuniorSqlExecutor({
    connectionString: args.databaseUrl,
    driver: args.driver,
    statementTimeoutMs: args.statementTimeoutMs,
  });
}

/** Return the process SQL executor for SQL-specific queries and transactions. */
export function getSqlExecutor(): JuniorSqlExecutor {
  const { sql } = getChatConfig();
  if (
    current?.databaseUrl !== sql.databaseUrl ||
    current.driver !== sql.driver ||
    current.statementTimeoutMs !== sql.statementTimeoutMs
  ) {
    if (current) {
      const previous = current;
      current = undefined;
      void previous.db.close().catch(() => undefined);
    }
    const db = createDb({
      databaseUrl: sql.databaseUrl,
      driver: sql.driver,
      statementTimeoutMs: sql.statementTimeoutMs,
    });
    current = {
      databaseUrl: sql.databaseUrl,
      driver: sql.driver,
      statementTimeoutMs: sql.statementTimeoutMs,
      db,
      store: createSqlStore(db),
      eventStore: createSqlConversationEventStore(db),
      searchStore: createSqlConversationMessageSearchStore(db),
    };
  }
  return current.db;
}

/** Return the process Drizzle database. */
export function getDb(): JuniorDatabase {
  return getSqlExecutor().db();
}

/** Return the SQL-backed conversation store. */
export function getConversationStore(): ConversationStore {
  getSqlExecutor();
  return current!.store;
}

/** Return the canonical SQL-backed conversation event store. */
export function getConversationEventStore(): ConversationEventStore {
  getSqlExecutor();
  return current!.eventStore;
}

/** Return the SQL-backed public provider-tenant conversation search store. */
export function getConversationMessageSearchStore(): ConversationMessageSearchStore {
  getSqlExecutor();
  return current!.searchStore;
}

/** Close the process SQL database when it has been opened. */
export async function closeDb(): Promise<void> {
  const previous = current;
  current = undefined;
  await previous?.db.close();
}
