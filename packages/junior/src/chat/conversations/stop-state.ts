// The stop state of a Conversation: when it stopped, and the end of a stop.
// It imports only the database, so code that reads the stop, such as core
// intake, does not load the Turn and prompt modules.
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { withConversationEventLock } from "@/conversation-events/lock";
import { juniorConversations } from "@/db/schema";

/** Return when a Conversation stopped, or undefined when it is not stopped. */
export async function getConversationStoppedAtMs(
  conversationId: string,
): Promise<number | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ stoppedAt: juniorConversations.stoppedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.stoppedAt?.getTime();
}

/**
 * End the stop of a Conversation and of the child agents below it, for new
 * work sent at `sentAtMs`: a person's input, or new work from its parent.
 * Nothing changes for work sent at or before the stop, so the input that a
 * stop drops does not undo it. Only Conversations that stopped no later than
 * this Conversation change, so a later stop of one child agent stays.
 */
export async function resumeConversationTree(
  conversationId: string,
  sentAtMs: number,
): Promise<void> {
  const subtree = sql`(select ${conversationSubtreeColumns.conversationId} from ${conversationSubtree([conversationId])})`;
  const executor = getSqlExecutor();
  // The Conversation lock comes before the rows, as for every writer under
  // that lock, such as an Event append. Rows first could deadlock with them.
  await withConversationEventLock(executor, conversationId, () =>
    executor.transaction(async () => {
      // The executor's transaction nests as a savepoint inside a caller's
      // lock. A Drizzle transaction would commit the caller's.
      const tx = executor.db();
      const rows = await tx
        .select({
          conversationId: juniorConversations.conversationId,
          stoppedAt: juniorConversations.stoppedAt,
        })
        .from(juniorConversations)
        .where(inArray(juniorConversations.conversationId, subtree))
        .orderBy(asc(juniorConversations.conversationId))
        .for("update");
      const stoppedAt = rows.find(
        (row) => row.conversationId === conversationId,
      )?.stoppedAt;
      if (!stoppedAt || sentAtMs <= stoppedAt.getTime()) {
        return;
      }
      await tx
        .update(juniorConversations)
        .set({ stoppedAt: null, detailVersion: nextDetailVersion })
        .where(
          and(
            inArray(juniorConversations.conversationId, subtree),
            lte(juniorConversations.stoppedAt, stoppedAt),
          ),
        );
    }),
  );
}
