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
  const result = await backfillConversationMetadataToSql({
    limit: CONVERSATION_METADATA_BACKFILL_LIMIT,
    source,
    target,
  });
  if (result.hasMore) {
    throw new Error(
      `Conversation metadata SQL backfill exceeded ${CONVERSATION_METADATA_BACKFILL_LIMIT} retained conversations`,
    );
  }

  return {
    existing: 0,
    migrated: result.copiedCount,
    missing: 0,
    scanned: result.copiedCount,
  };
}

export const conversationMetadataSqlMigration = {
  name: "backfill-conversation-metadata-sql",
  run: migrateConversationMetadataToSql,
};
