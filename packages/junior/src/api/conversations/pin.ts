import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import type { JuniorDatabase } from "@/db/db";
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
import { isTopLevelKind } from "@/chat/conversations/kind-behavior";

/**
 * Pin or unpin one conversation for the signed-in viewer.
 *
 * A pin lives on the viewer's participant row, and that row grants send and
 * control access. So only a participant can pin, the same as archive. A pin
 * also restores an archived conversation for everyone, because the Pinned
 * section shows only active conversations. A pin on a child would be a fact
 * of the child, not of the viewer's root, and no list shows child pins yet,
 * so only a root can be pinned.
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
  return await executor.transaction(() =>
    setPin(executor.db(), viewer, conversationId, body.pinned),
  );
}

async function setPin(
  db: JuniorDatabase,
  viewer: User,
  conversationId: string,
  pinned: boolean,
): Promise<PinConversationResponse> {
  // The lock orders a pin with a last-subscriber unsubscribe, so the pin
  // sees and restores that archive (contract: `subscription.ts`).
  const [conversation] = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      kind: juniorConversations.kind,
      lastActivityAt: juniorConversations.lastActivityAt,
      parentConversationId: juniorConversations.parentConversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1)
    .for("no key update");
  if (!conversation) throwApiError(404, "Conversation not found.");
  // The viewer passed the access check above, so the root id is safe to name.
  // MCP output has no root field, and the caller needs it to act.
  if (!isTopLevelKind(conversationKindFromRow(conversation))) {
    throwApiError(
      409,
      `A child conversation cannot be pinned or unpinned. It uses its root's pin: ${conversation.rootConversationId ?? conversation.parentConversationId}.`,
    );
  }
  // Pins are viewer marks, which the detail ETag reads on each request, so
  // they need no detail version bump.
  if (!pinned) {
    // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
    await db
      .update(juniorConversationParticipants)
      .set({ pinnedAt: null, pinPosition: null })
      .where(
        and(
          eq(juniorConversationParticipants.userId, viewer.id),
          eq(juniorConversationParticipants.rootConversationId, conversationId),
        ),
      );
    return { pinnedAt: null };
  }

  if (conversation.archivedAt) {
    await setArchivedAt(db, [conversationId], null);
  }
  const pinnedAt = new Date();
  // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
  await db
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: conversation.lastActivityAt,
      pinnedAt,
      rootConversationId: conversationId,
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationParticipants.userId,
        juniorConversationParticipants.rootConversationId,
      ],
      // A new pin has no place yet, so it sorts first in Pinned. A pin also
      // subscribes the viewer again, because Pinned is part of the feed.
      set: { pinnedAt, pinPosition: null, unsubscribedAt: null },
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
      // The client can see only the pins in one feed page. A placed pin that
      // is not in the list moves after the listed pins and keeps its order,
      // so its old place cannot collide with a new index.
      pinPosition: sql`case ${participants.rootConversationId} ${positions} else ${participants.pinPosition} + ${ids.length}::integer end`,
    })
    .where(
      and(eq(participants.userId, viewer.id), isNotNull(participants.pinnedAt)),
    )
    .returning({ rootConversationId: participants.rootConversationId });
  const updatedIds = new Set(updated.map((row) => row.rootConversationId));
  return { conversationIds: ids.filter((id) => updatedIds.has(id)) };
}
