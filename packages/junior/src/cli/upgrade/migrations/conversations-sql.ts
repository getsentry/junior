import { getChatConfig } from "@/chat/config";
import { createSqlStore, type SqlStore } from "@/chat/conversations/sql/store";
import { createStateConversationStore } from "@/chat/conversations/state";
import { addAgentTurnUsage } from "@/chat/usage";
import { listAgentTurnSessionSummariesForConversations } from "@/chat/state/turn-session";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { MigrationContext, MigrationResult } from "../types";

const CONVERSATION_BACKFILL_LIMIT = 10_000;

/** Copy retained conversation records into the configured SQL store. */
export async function migrateConversationsToSql(
  context: MigrationContext,
  options: {
    batchSize?: number;
    target?: Pick<SqlStore, "backfillConversation" | "listByActivity">;
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
    const [stateConversations, sqlConversations] = await Promise.all([
      source.listByActivity({ limit }),
      target.listByActivity({ limit }),
    ]);
    const byId = new Map(
      sqlConversations.map((conversation) => [
        conversation.conversationId,
        conversation,
      ]),
    );
    for (const conversation of stateConversations) {
      const existing = byId.get(conversation.conversationId);
      const existingExecutionAt =
        existing?.execution.updatedAtMs ?? existing?.updatedAtMs ?? 0;
      const stateExecutionAt =
        conversation.execution.updatedAtMs ?? conversation.updatedAtMs;
      if (!existing || stateExecutionAt >= existingExecutionAt) {
        byId.set(conversation.conversationId, conversation);
      }
    }
    const conversations = [...byId.values()]
      .sort(
        (left, right) =>
          right.lastActivityAtMs - left.lastActivityAtMs ||
          left.conversationId.localeCompare(right.conversationId),
      )
      .slice(0, limit);
    const summaries = await listAgentTurnSessionSummariesForConversations(
      context.stateAdapter,
      conversations.map((conversation) => conversation.conversationId),
    );
    for (const conversation of conversations) {
      const conversationSummaries =
        summaries.get(conversation.conversationId) ?? [];
      const executionSummary = conversation.execution.runId
        ? conversationSummaries.find(
            (summary) => summary.sessionId === conversation.execution.runId,
          )
        : undefined;
      await target.backfillConversation(
        conversation,
        conversationSummaries.length > 0
          ? {
              durationMs: conversationSummaries.reduce(
                (total, summary) => total + summary.cumulativeDurationMs,
                0,
              ),
              usage: addAgentTurnUsage(
                ...conversationSummaries.map(
                  (summary) => summary.cumulativeUsage,
                ),
              ),
              executionDurationMs: executionSummary?.cumulativeDurationMs ?? 0,
              executionUsage: executionSummary?.cumulativeUsage,
            }
          : undefined,
      );
    }

    return {
      existing: 0,
      migrated: conversations.length,
      missing: 0,
      scanned: conversations.length,
    };
  } finally {
    await closeTarget?.();
  }
}

export const sqlConversationMigration = {
  name: "backfill-conversations-sql",
  run: migrateConversationsToSql,
};
