import { getChatConfig } from "@/chat/config";
import {
  backfillToSql,
  type BackfillTarget,
} from "@/chat/conversations/sql/backfill";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationContext, MigrationResult } from "../types";

const CONVERSATION_BACKFILL_LIMIT = 10_000;

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
    const { sql } = getChatConfig();
    const executor = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
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
