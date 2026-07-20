import { getChatConfig } from "@/chat/config";
import { importConversationFromLegacy } from "./conversation-history/import";
import { createStateConversationStore } from "./conversation-history/state-conversation-store";
import type { LegacyAdvisorSessionReader } from "./conversation-history/advisor-session";
import type { ConversationMessage as ThreadConversationMessage } from "@/chat/state/conversation";
import type { SessionLogStore } from "./conversation-history/session-log";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { JuniorSqlExecutor } from "@/db/db";
import type { MigrationContext, MigrationResult } from "../types";

const HISTORY_BACKFILL_PAGE_SIZE = 500;

/**
 * Bulk-import legacy Redis conversation history (session logs, advisor blobs,
 * and visible messages) into SQL, paginating newest-first through the complete
 * retained activity index. Idempotent per conversation: it skips any
 * conversation that already has event rows.
 */
export async function migrateConversationHistoryToSql(
  context: MigrationContext,
  options: {
    batchSize?: number;
    executor?: JuniorSqlExecutor;
    sessionLogStore?: SessionLogStore;
    advisorSessionStore?: LegacyAdvisorSessionReader;
    loadVisibleMessages?: (
      conversationId: string,
    ) => Promise<ThreadConversationMessage[]>;
  } = {},
): Promise<MigrationResult> {
  const source = createStateConversationStore(context.stateAdapter);
  const chatConfig = getChatConfig();
  let executor = options.executor;
  let closeExecutor: (() => Promise<void>) | undefined;
  if (!executor) {
    const { sql } = chatConfig;
    executor = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
    });
    closeExecutor = () => executor!.close();
  }
  const pageSize = Math.max(
    1,
    Math.floor(options.batchSize ?? HISTORY_BACKFILL_PAGE_SIZE),
  );
  try {
    let migrated = 0;
    let existing = 0;
    let scanned = 0;
    let offset = 0;
    while (true) {
      const conversations = await source.listByActivity({
        limit: pageSize,
        offset,
      });
      if (conversations.length === 0) {
        break;
      }
      for (const conversation of conversations) {
        const result = await importConversationFromLegacy(
          conversation.conversationId,
          {
            executor,
            modelId: chatConfig.bot.modelId,
            conversationRecord: conversation,
            ...(options.sessionLogStore
              ? { sessionLogStore: options.sessionLogStore }
              : {}),
            ...(options.advisorSessionStore
              ? { advisorSessionStore: options.advisorSessionStore }
              : {}),
            ...(options.loadVisibleMessages
              ? { loadVisibleMessages: options.loadVisibleMessages }
              : {}),
          },
        );
        if (result.imported) {
          migrated += 1;
        } else {
          existing += 1;
        }
      }
      scanned += conversations.length;
      offset += conversations.length;
    }
    return {
      existing,
      migrated,
      missing: 0,
      scanned,
    };
  } finally {
    await closeExecutor?.();
  }
}

export const sqlConversationHistoryMigration = {
  name: "backfill-conversation-events-sql",
  run: migrateConversationHistoryToSql,
};
