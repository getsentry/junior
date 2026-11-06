import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { withConversationMutationLock } from "@/chat/conversations/sql/store";
import { juniorConversations } from "@/db/schema";
import { throwApiError } from "../http";
import type {
  RenameConversationBody,
  RenameConversationResponse,
} from "../schema/conversation-title";
import { readConversationAccessFromSql } from "./access";

/**
 * Rename one conversation. The title is shared, so only a participant can
 * change it, the same as pin and archive. Automatic titles are set once, so a
 * later Turn keeps this title.
 */
export async function renameConversation(
  viewer: User,
  conversationId: string,
  body: RenameConversationBody,
): Promise<RenameConversationResponse> {
  const executor = getSqlExecutor();
  const access = await readConversationAccessFromSql(
    executor.db(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  // Take the lock that recordActivity holds while it reads and writes back the
  // title, so a concurrent Turn cannot restore the old title.
  const [row] = await withConversationMutationLock(
    executor,
    conversationId,
    async () =>
      await executor
        .db()
        .update(juniorConversations)
        .set({ detailVersion: nextDetailVersion, title: body.title })
        .where(eq(juniorConversations.conversationId, conversationId))
        .returning({ title: juniorConversations.title }),
  );
  if (!row?.title) throwApiError(404, "Conversation not found.");
  return { title: row.title };
}
