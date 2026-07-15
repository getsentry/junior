import { buildConversationDetail } from "./detail-projection";
import { getSqlExecutor } from "@/chat/db";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { readConversationRecordFromSql } from "./list.query";
import type { ConversationDetailReport } from "./schema";

/** Read one SQL conversation and its canonical, root-authorized event history. */
export async function readConversationDetailFromSql(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const executor = getSqlExecutor();
  return executor.transaction(async () =>
    withConversationEventLock(executor, conversationId, async () => {
      const { rootConversationId, visibility } = await resolveRootVisibility(
        executor,
        conversationId,
      );
      const record = await readConversationRecordFromSql(
        conversationId,
        executor.db(),
      );
      if (!record) return undefined;
      const events =
        await createSqlConversationEventStore(executor).loadHistory(
          conversationId,
        );
      const effectiveVisibility =
        visibility === "public" || visibility === "private"
          ? visibility
          : undefined;
      return buildConversationDetail({
        ...record,
        effectiveVisibility,
        events,
        privacyConversationId: rootConversationId,
        usage: record.usage ?? undefined,
      });
    }),
  );
}
