import { eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { nextDetailVersion } from "./detail-version";
import { withConversationMutationLock } from "./store";

/**
 * Replace one Conversation's title. Returns the stored title, or undefined
 * when the Conversation does not exist.
 *
 * recordActivity reads the title and writes it back under the mutation lock,
 * so this write takes the same lock. A concurrent Turn cannot restore the old
 * title.
 */
export async function setConversationTitle(
  executor: JuniorSqlDatabase,
  conversationId: string,
  title: string,
): Promise<string | undefined> {
  return await withConversationMutationLock(
    executor,
    conversationId,
    async () => {
      const [row] = await executor
        .db()
        .update(juniorConversations)
        .set({ detailVersion: nextDetailVersion, title })
        .where(eq(juniorConversations.conversationId, conversationId))
        .returning({ title: juniorConversations.title });
      return row?.title ?? undefined;
    },
  );
}
