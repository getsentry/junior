import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import type { Conversation } from "@/chat/conversations/store";
import { juniorConversations } from "@/db/schema";
import { isTopLevel } from "@/chat/conversations/kind-behavior";
import { topLevelConversation } from "@/chat/conversations/sql/listed";
import { conversationAncestorsOrSelf } from "@/chat/conversations/sql/subtree";

/** True when the Conversation is a root that delivers to a Location. */
export function canPauseConversationDelivery(
  conversation: Pick<Conversation, "location" | "parentConversationId">,
): boolean {
  return isTopLevel(conversation) && conversation.location !== undefined;
}

const rootConversation = (conversationId: string) =>
  and(
    eq(juniorConversations.conversationId, conversationId),
    topLevelConversation(),
  );

/**
 * Stop Delivery of a root's Event Turn replies to its Location. Returns false
 * when Delivery was already paused or the root does not exist.
 */
export async function pauseConversationDelivery(
  conversationId: string,
): Promise<boolean> {
  const rows = await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ deliveryPausedAt: new Date(), detailVersion: nextDetailVersion })
    .where(
      and(
        rootConversation(conversationId),
        isNull(juniorConversations.deliveryPausedAt),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  return rows.length > 0;
}

/**
 * Deliver a root's Event Turn replies to its Location again. Returns false
 * when Delivery was not paused or the root does not exist.
 */
export async function resumeConversationDelivery(
  conversationId: string,
): Promise<boolean> {
  const rows = await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ deliveryPausedAt: null, detailVersion: nextDetailVersion })
    .where(
      and(
        rootConversation(conversationId),
        isNotNull(juniorConversations.deliveryPausedAt),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  return rows.length > 0;
}

/**
 * True while this Conversation is detached from its Location. Only a root
 * with a Location stores the pause, so a child agent reads the pause of its
 * root.
 */
export async function isConversationDeliveryPaused(
  conversationId: string,
): Promise<boolean> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ id: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        sql`${juniorConversations.conversationId} IN ${conversationAncestorsOrSelf(sql`${conversationId}`)}`,
        isNotNull(juniorConversations.deliveryPausedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}
