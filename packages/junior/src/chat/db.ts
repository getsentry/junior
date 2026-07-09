import { getChatConfig, type SqlDriver } from "@/chat/config";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationStore } from "@/chat/conversations/store";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import type { AgentStepStore } from "@/chat/conversations/history";
import type { JuniorDatabase, JuniorSqlExecutor } from "@/chat/sql/db";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";

let current:
  | {
      databaseUrl: string;
      db: JuniorSqlExecutor;
      driver: SqlDriver;
      store: ConversationStore;
      stepStore: AgentStepStore;
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

function getSqlExecutor(): JuniorSqlExecutor {
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
      stepStore: createSqlAgentStepStore(db),
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

/** Return the SQL-backed durable agent step store. */
export function getAgentStepStore(): AgentStepStore {
  getSqlExecutor();
  return current!.stepStore;
}

/** Close the process SQL database when it has been opened. */
export async function closeDb(): Promise<void> {
  const previous = current;
  current = undefined;
  await previous?.db.close();
}
