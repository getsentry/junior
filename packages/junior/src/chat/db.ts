import { getChatConfig, type SqlDriver } from "@/chat/config";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import type { ConversationEventStore } from "@/chat/conversations/history";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import type { ConversationMessageStore } from "@/chat/conversations/messages";
import { createSqlConversationSearchStore } from "@/chat/conversations/sql/search";
import type { ConversationSearchStore } from "@/chat/conversations/search";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import { SubagentLineageService } from "@/chat/services/subagent-lineage";

let current:
  | {
      databaseUrl: string;
      db: JuniorSqlExecutor;
      driver: SqlDriver;
      store: ConversationStore;
      eventStore: ConversationEventStore;
      messageStore: ConversationMessageStore;
      searchStore: ConversationSearchStore;
      subagentLineage: SubagentLineageService;
    }
  | undefined;

function createDb(args: {
  databaseUrl: string;
  driver: SqlDriver;
}): JuniorSqlExecutor {
  return createJuniorSqlExecutor({
    connectionString: args.databaseUrl,
    driver: args.driver,
  });
}

/**
 * Return the process SQL executor. Exposed for the one-time legacy import
 * writer, which needs explicit-`seq`/epoch inserts the event-store port omits.
 */
export function getSqlExecutor(): JuniorSqlExecutor {
  const { sql } = getChatConfig();
  if (
    current?.databaseUrl !== sql.databaseUrl ||
    current.driver !== sql.driver
  ) {
    if (current) {
      const previous = current;
      current = undefined;
      void previous.db.close().catch(() => undefined);
    }
    const db = createDb({
      databaseUrl: sql.databaseUrl,
      driver: sql.driver,
    });
    current = {
      databaseUrl: sql.databaseUrl,
      driver: sql.driver,
      db,
      store: createSqlStore(db),
      eventStore: createSqlConversationEventStore(db),
      messageStore: createSqlConversationMessageStore(db),
      searchStore: createSqlConversationSearchStore(db),
      subagentLineage: new SubagentLineageService(db),
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

/** Return the SQL-backed visible conversation message store. */
export function getConversationMessageStore(): ConversationMessageStore {
  getSqlExecutor();
  return current!.messageStore;
}

/** Return the SQL-backed public provider-tenant conversation search store. */
export function getConversationSearchStore(): ConversationSearchStore {
  getSqlExecutor();
  return current!.searchStore;
}

/** Return the SQL-backed immutable child-conversation lineage service. */
export function getSubagentLineageService(): SubagentLineageService {
  getSqlExecutor();
  return current!.subagentLineage;
}

/** Close the process SQL database when it has been opened. */
export async function closeDb(): Promise<void> {
  const previous = current;
  current = undefined;
  await previous?.db.close();
}
