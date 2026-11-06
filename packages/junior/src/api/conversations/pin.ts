import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  ReorderPinnedConversationsBody,
  ReorderPinnedConversationsResponse,
} from "../schema/conversation-pin";
import { readConversationAccessFromSql } from "./access";

/**
 * Pin or unpin one conversation for the signed-in viewer.
 *
 * A pin lives on the viewer's participant row, and that row grants send and
 * control access. So only a participant can pin, the same as archive. The
 * root actor may have no row yet, so pinning adds it. A pin also restores an
 * archived conversation, because the Pinned section shows only active
 * conversations.
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
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const executor = getSqlExecutor();
  const rootConversationId = await resolveRootConversationId(
    executor,
    conversationId,
  );
  const db = executor.db();
  // Pins are viewer marks, which the detail ETag reads on each request, so
  // they need no detail version bump.
  if (!body.pinned) {
    // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
    await db
      .update(juniorConversationParticipants)
      .set({ pinnedAt: null, pinPosition: null })
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
  // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
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
      // A new pin has no place yet, so it sorts first in Pinned.
      set: { archivedAt: null, pinnedAt, pinPosition: null },
    });
  return { pinnedAt: pinnedAt.toISOString() };
}

/**
 * Save the viewer's Pinned order. Each listed pin takes its index as its
 * place. The update reads only the viewer's own pinned rows, so an id that
 * the viewer did not pin changes nothing and grants nothing.
 */
export async function reorderPinnedConversations(
  viewer: User,
  body: ReorderPinnedConversationsBody,
): Promise<ReorderPinnedConversationsResponse> {
  const ids = body.conversationIds;
  const participants = juniorConversationParticipants;
  const positions = sql.join(
    ids.map((id, index) => sql`when ${id} then ${index}::integer`),
    sql` `,
  );
  // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
  const updated = await getDb()
    .update(participants)
    .set({
      pinPosition: sql`case ${participants.rootConversationId} ${positions} end`,
    })
    .where(
      and(
        eq(participants.userId, viewer.id),
        isNotNull(participants.pinnedAt),
        inArray(participants.rootConversationId, ids),
      ),
    )
    .returning({ rootConversationId: participants.rootConversationId });
  const updatedIds = new Set(updated.map((row) => row.rootConversationId));
  return { conversationIds: ids.filter((id) => updatedIds.has(id)) };
}
