import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { setConversationTitle } from "@/chat/conversations/sql/title";
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
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const title = await setConversationTitle(
    getSqlExecutor(),
    conversationId,
    body.title,
  );
  if (!title) throwApiError(404, "Conversation not found.");
  return { title };
}
