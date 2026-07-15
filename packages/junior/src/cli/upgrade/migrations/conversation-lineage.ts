import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getChatConfig } from "@/chat/config";
import type { JuniorSqlExecutor } from "@/db/db";
import { createJuniorSqlExecutor } from "@/db/executor";
import { juniorConversations } from "@/db/schema";
import type { MigrationContext, MigrationResult } from "../types";

const LINEAGE_BATCH_SIZE = 500;
const LINEAGE_BACKFILL_LOCK = "junior:upgrade:conversation-lineage";

async function resolveHistoricalRoot(
  executor: JuniorSqlExecutor,
  conversationId: string,
): Promise<string> {
  let currentId = conversationId;
  const seen = new Set<string>();
  let declaredRootConversationId: string | undefined;
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const rows = await executor
      .db()
      .select({
        conversationId: juniorConversations.conversationId,
        parentConversationId: juniorConversations.parentConversationId,
        rootConversationId: juniorConversations.rootConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, currentId));
    const row = rows[0];
    if (!row) {
      throw new Error(
        `Conversation lineage references missing parent ${currentId}`,
      );
    }
    if (
      row.rootConversationId &&
      declaredRootConversationId &&
      row.rootConversationId !== declaredRootConversationId
    ) {
      throw new Error("Conversation lineage declares conflicting roots");
    }
    if (row.rootConversationId) {
      declaredRootConversationId = row.rootConversationId;
    }
    if (!row.parentConversationId) {
      if (
        declaredRootConversationId &&
        declaredRootConversationId !== row.conversationId
      ) {
        throw new Error(
          "Conversation lineage does not resolve to its declared root",
        );
      }
      return row.conversationId;
    }
    currentId = row.parentConversationId;
  }
  throw new Error(`Conversation lineage contains a cycle at ${currentId}`);
}

/** Fill only historical root lineage; unknown fork/correlation stays null and isolated. */
export async function migrateConversationLineage(
  _context: MigrationContext,
  options: { batchSize?: number; executor?: JuniorSqlExecutor } = {},
): Promise<MigrationResult> {
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
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? LINEAGE_BATCH_SIZE),
  );
  let migrated = 0;
  try {
    while (true) {
      const processed = await executor.withLock(
        LINEAGE_BACKFILL_LOCK,
        async () => {
          const rows = await executor!
            .db()
            .select({ conversationId: juniorConversations.conversationId })
            .from(juniorConversations)
            .where(
              and(
                isNotNull(juniorConversations.parentConversationId),
                isNull(juniorConversations.rootConversationId),
              ),
            )
            .orderBy(asc(juniorConversations.conversationId))
            .limit(batchSize);
          await executor!.transaction(async () => {
            for (const row of rows) {
              const rootConversationId = await resolveHistoricalRoot(
                executor!,
                row.conversationId,
              );
              await executor!
                .db()
                .update(juniorConversations)
                .set({ rootConversationId })
                .where(
                  eq(juniorConversations.conversationId, row.conversationId),
                );
            }
          });
          return rows.length;
        },
      );
      if (processed === 0) {
        break;
      }
      migrated += processed;
    }
    return { existing: 0, migrated, missing: 0, scanned: migrated };
  } finally {
    await closeExecutor?.();
  }
}

export const conversationLineageMigration = {
  name: "backfill-conversation-lineage",
  run: migrateConversationLineage,
};
