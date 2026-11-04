import type { User } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  PinConversationBody,
  PinConversationResponse,
} from "../schema/conversation-pin";
import { readConversationAccessFromSql } from "./access";

/**
 * Pin or unpin one conversation for the signed-in viewer.
 *
 * A pin lives on the viewer's participant row, so pinning adds that row when
 * it is missing. The row also grants private access, so only a viewer who can
 * already read the conversation can pin it. A pin also restores an archived
 * conversation, because the Pinned section shows only active conversations.
 */
export async function pinConversation(
  viewer: User,
  conversationId: string,
  body: PinConversationBody,
): Promise<PinConversationResponse> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.canViewPrivateContent) {
    throwApiError(404, "Conversation not found.");
  }
  const executor = getSqlExecutor();
  const rootConversationId = await resolveRootConversationId(
    executor,
    conversationId,
  );
  const db = executor.db();
  if (!body.pinned) {
    await db
      .update(juniorConversationParticipants)
      .set({ pinnedAt: null })
      .where(
        and(
          eq(juniorConversationParticipants.userId, viewer.id),
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
        ),
      );
    return { pinnedAt: null };
  }

  const [root] = await db
    .select({ lastActivityAt: juniorConversations.lastActivityAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, rootConversationId))
    .limit(1);
  if (!root) throwApiError(404, "Conversation not found.");
  const pinnedAt = new Date();
  await db
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: root.lastActivityAt,
      pinnedAt,
      rootConversationId,
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationParticipants.userId,
        juniorConversationParticipants.rootConversationId,
      ],
      set: { archivedAt: null, pinnedAt },
    });
  return { pinnedAt: pinnedAt.toISOString() };
}
