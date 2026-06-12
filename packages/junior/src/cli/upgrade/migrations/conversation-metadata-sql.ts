import { getChatConfig } from "@/chat/config";
import {
  backfillConversationMetadataToSql,
  type ConversationMetadataSqlBackfillTarget,
} from "@/chat/metadata/sql/backfill";
import { createSqlConversationMetadataStore } from "@/chat/metadata/sql/store";
import { createStateConversationMetadataStore } from "@/chat/metadata/state-store";
import { createNeonJuniorSqlExecutor } from "@/chat/sql/neon";
import type { MigrationContext, MigrationResult } from "../types";

const CONVERSATION_METADATA_BACKFILL_LIMIT = 10_000;

/**
 * Copy retained conversation execution metadata into the configured SQL store.
 */
export async function migrateConversationMetadataToSql(
  context: MigrationContext,
  options: {
    batchSize?: number;
    target?: ConversationMetadataSqlBackfillTarget;
  } = {},
): Promise<MigrationResult> {
  const databaseUrl = context.sqlDatabaseUrl ?? getChatConfig().sql.databaseUrl;
  if (!databaseUrl && !options.target) {
    context.io.info(
      "Skipping SQL conversation metadata backfill: no Junior SQL database URL is configured.",
    );
    return {
      existing: 0,
      migrated: 0,
      missing: 0,
      scanned: 0,
      skipped: 1,
    };
  }

  const source = createStateConversationMetadataStore(context.stateAdapter);
  const target =
    options.target ??
    createSqlConversationMetadataStore(
      createNeonJuniorSqlExecutor({
        connectionString: databaseUrl!,
      }),
    );
  const limit = Math.max(
    1,
    options.batchSize ?? CONVERSATION_METADATA_BACKFILL_LIMIT,
  );
  let copiedCount = 0;
  let hasMore = false;
  do {
    const result = await backfillConversationMetadataToSql({
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
}

export const conversationMetadataSqlMigration = {
  name: "backfill-conversation-metadata-sql",
  run: migrateConversationMetadataToSql,
};
