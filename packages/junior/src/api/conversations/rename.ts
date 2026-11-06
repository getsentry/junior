import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
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
  const db = getDb();
  const access = await readConversationAccessFromSql(
    db,
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const [row] = await db
    .update(juniorConversations)
    .set({ detailVersion: nextDetailVersion, title: body.title })
    .where(eq(juniorConversations.conversationId, conversationId))
    .returning({ title: juniorConversations.title });
  if (!row?.title) throwApiError(404, "Conversation not found.");
  return { title: row.title };
}
