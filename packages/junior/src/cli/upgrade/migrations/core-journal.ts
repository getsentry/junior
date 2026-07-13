import { getChatConfig } from "@/chat/config";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationJsonValue } from "@sentry/junior-migrations";
import { createJiti } from "jiti";
import { migrateAgentTurnSessionActor } from "./agent-turn-session-actor";
import { migrateConversationHistoryToSql } from "./conversations-history-sql";
import { migrateConversationsToSql } from "./conversations-sql";
import { migrateRedisConversationState } from "./redis-conversation-state";
import type { MigrationContext, MigrationResult } from "../types";

const migrationLoader = createJiti(import.meta.url, { moduleCache: false });

async function runCoreMigrationTask(
  context: MigrationContext,
  name: string,
): Promise<MigrationJsonValue | undefined> {
  switch (name) {
    case "agent-turn-session-actor-v1":
      return await migrateAgentTurnSessionActor(context);
    case "redis-conversation-state-v1":
      return await migrateRedisConversationState(context);
    case "conversations-to-sql-v1":
      return await migrateConversationsToSql(context);
    case "conversation-history-to-sql-v1":
      return await migrateConversationHistoryToSql(context);
    default:
      throw new Error(`Unknown core migration task: ${name}`);
  }
}

/** Apply core schema migrations and versioned legacy data tasks in journal order. */
export async function migrateCoreJournal(
  context: MigrationContext,
): Promise<MigrationResult> {
  const { sql } = getChatConfig();
  const executor = createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
  try {
    const result = await migrateSchema(executor, {
      loadTypeScript: async (path) =>
        await migrationLoader.import<Record<string, unknown>>(path),
      log: context.io.info,
      mode: "all",
      runTask: async (name) => await runCoreMigrationTask(context, name),
      stateAdapter: context.stateAdapter,
    });
    return {
      existing: result.existing,
      migrated: result.migrated,
      missing: 0,
      scanned: result.scanned,
      skipped: result.skipped,
    };
  } finally {
    await executor.close();
  }
}
