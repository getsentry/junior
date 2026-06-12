import { getChatConfig } from "@/chat/config";
import {
  backfillToSql,
  type BackfillTarget,
} from "@/chat/conversations/sql/backfill";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
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
  const databaseUrl = context.sqlDatabaseUrl ?? getChatConfig().sql.databaseUrl;
  if (!databaseUrl && !options.target) {
    context.io.info(
      "Skipping SQL conversation record backfill: no Junior SQL database URL is configured.",
    );
    return {
      existing: 0,
      migrated: 0,
      missing: 0,
      scanned: 0,
      skipped: 1,
    };
  }

  const source = createStateConversationStore(context.stateAdapter);
  let target = options.target;
  let closeTarget: (() => Promise<void>) | undefined;
  if (!target) {
    const executor = createNeonJuniorSqlExecutor({
      connectionString: databaseUrl!,
    });
    target = createSqlStore(executor);
    closeTarget = () => executor.close();
  }
  const limit = Math.max(1, options.batchSize ?? CONVERSATION_BACKFILL_LIMIT);
  let copiedCount = 0;
  let hasMore = false;
  try {
    do {
      const result = await backfillToSql({
        limit,
        offset: copiedCount,
        source,
        target,
      });
      copiedCount += result.copiedCount;
      hasMore = result.hasMore;
    } while (hasMore);

    return {
      existing: 0,
      migrated: copiedCount,
      missing: 0,
      scanned: copiedCount,
    };
  } finally {
    await closeTarget?.();
  }
}

export const sqlConversationMigration = {
  name: "backfill-conversations-sql",
  run: migrateConversationsToSql,
};
