import { getChatConfig } from "@/chat/config";
import {
  backfillToSql,
  type BackfillTarget,
} from "@/chat/conversations/sql/backfill";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
import type { MigrationContext, MigrationResult } from "../types";

const CONVERSATION_BACKFILL_LIMIT = 10_000;
const REQUIRED_SQL_DATABASE_URL_MESSAGE =
  "Junior SQL database URL is required for conversation metadata upgrade. Set JUNIOR_DATABASE_URL or DATABASE_URL.";

/** Return the SQL URL required by conversation metadata upgrade. */
export function requireConversationSqlDatabaseUrl(
  context: MigrationContext,
): string {
  const databaseUrl = context.sqlDatabaseUrl ?? getChatConfig().sql.databaseUrl;
  if (!databaseUrl) {
    throw new Error(REQUIRED_SQL_DATABASE_URL_MESSAGE);
  }
  return databaseUrl;
}

/** Copy retained conversation records into the configured SQL store. */
export async function migrateConversationsToSql(
  context: MigrationContext,
  options: {
    batchSize?: number;
    target?: BackfillTarget;
  } = {},
): Promise<MigrationResult> {
  const source = createStateConversationStore(context.stateAdapter);
  let target = options.target;
  let closeTarget: (() => Promise<void>) | undefined;
  if (!target) {
    const databaseUrl = requireConversationSqlDatabaseUrl(context);
    const executor = createJuniorSqlExecutor({
      connectionString: databaseUrl,
      driver: context.sqlDriver ?? getChatConfig().sql.driver,
    });
    target = createSqlStore(executor);
    closeTarget = () => executor.close();
  }
  const limit = Math.max(1, options.batchSize ?? CONVERSATION_BACKFILL_LIMIT);
  try {
    const result = await backfillToSql({
      limit,
      source,
      target,
    });

    return {
      existing: 0,
      migrated: result.copiedCount,
      missing: 0,
      scanned: result.copiedCount,
    };
  } finally {
    await closeTarget?.();
  }
}

export const sqlConversationMigration = {
  name: "backfill-conversations-sql",
  run: migrateConversationsToSql,
};
