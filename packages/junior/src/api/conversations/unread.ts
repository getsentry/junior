import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  MarkConversationUnreadBody,
  MarkConversationUnreadResponse,
} from "../schema/conversation-unread";
import { readConversationAccessFromSql } from "./access";

/**
 * Mark one conversation read or unread for the signed-in viewer.
 *
 * Read moves the viewer's read time to now. Unread moves it just before the
 * root's last activity, so the feed shows the conversation as unread while
 * it is idle. The read time lives on the viewer's participant row, so only a
 * participant can change it, the same as pin and archive. The root actor may
 * have no row yet, so this adds it.
 */
export async function markConversationUnread(
  viewer: User,
  conversationId: string,
  body: MarkConversationUnreadBody,
): Promise<MarkConversationUnreadResponse> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const executor = getSqlExecutor();
  const rootConversationId = await resolveRootConversationId(
    executor,
    conversationId,
  );
  const db = executor.db();
  const [root] = await db
    .select({ lastActivityAt: juniorConversations.lastActivityAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, rootConversationId))
    .limit(1);
  if (!root) throwApiError(404, "Conversation not found.");
  const readAt = body.unread
    ? new Date(root.lastActivityAt.getTime() - 1)
    : new Date();
  // Viewer marks are read on each request, so they need no detail version
  // bump.
  // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
  await db
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: root.lastActivityAt,
      readAt,
      rootConversationId,
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationParticipants.userId,
        juniorConversationParticipants.rootConversationId,
      ],
      set: { readAt },
    });
  return { readAt: readAt.toISOString() };
}
