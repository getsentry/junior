import { getChatConfig } from "@/chat/config";
import { importConversationFromLegacy } from "@/chat/conversations/legacy-import";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { createStateConversationStore } from "@/chat/conversations/state";
import type { AdvisorSessionStore } from "@/chat/tools/advisor/session-store";
import type { ConversationMessage as ThreadConversationMessage } from "@/chat/state/conversation";
import type { SessionLogStore } from "@/chat/state/session-log";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { JuniorSqlExecutor } from "@/db/db";
import type { MigrationContext, MigrationResult } from "../types";

const HISTORY_BACKFILL_LIMIT = 10_000;

/**
 * Bulk-import legacy Redis conversation history (session logs, advisor blobs,
 * and visible messages) into SQL, bounded newest-first over the same activity
 * scan as the metadata backfill. Idempotent per conversation: it skips any
 * conversation that already has step rows.
 */
export async function migrateConversationHistoryToSql(
  context: MigrationContext,
  options: {
    batchSize?: number;
    executor?: JuniorSqlExecutor;
    sessionLogStore?: SessionLogStore;
    advisorSessionStore?: AdvisorSessionStore;
    loadVisibleMessages?: (
      conversationId: string,
    ) => Promise<ThreadConversationMessage[]>;
  } = {},
): Promise<MigrationResult> {
  const source = createStateConversationStore(context.stateAdapter);
  let executor = options.executor;
  let closeExecutor: (() => Promise<void>) | undefined;
  if (!executor) {
    const { sql } = getChatConfig();
    executor = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
    });
    closeExecutor = () => executor!.close();
  }
  const limit = Math.max(1, options.batchSize ?? HISTORY_BACKFILL_LIMIT);
  try {
    const messageStore = createSqlConversationMessageStore(executor);
    const conversations = await source.listByActivity({ limit });
    let migrated = 0;
    let existing = 0;
    for (const conversation of conversations) {
      const result = await importConversationFromLegacy(
        conversation.conversationId,
        {
          executor,
          messageStore,
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
    return {
      existing,
      migrated,
      missing: 0,
      scanned: conversations.length,
    };
  } finally {
    await closeExecutor?.();
  }
}

export const sqlConversationHistoryMigration = {
  name: "backfill-agent-steps-sql",
  run: migrateConversationHistoryToSql,
};
