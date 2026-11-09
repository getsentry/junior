import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { juniorConversations } from "@/db/schema";

const rootConversation = (conversationId: string) =>
  and(
    eq(juniorConversations.conversationId, conversationId),
    isNull(juniorConversations.parentConversationId),
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

/** Deliver a root's Event Turn replies to its Location again. */
export async function resumeConversationDelivery(
  conversationId: string,
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorConversations)
    .set({ deliveryPausedAt: null, detailVersion: nextDetailVersion })
    .where(
      and(
        rootConversation(conversationId),
        isNotNull(juniorConversations.deliveryPausedAt),
      ),
    );
}

/** True while a root's Event Turn replies stay out of its Location. */
export async function isConversationDeliveryPaused(
  conversationId: string,
): Promise<boolean> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ pausedAt: juniorConversations.deliveryPausedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return Boolean(row?.pausedAt);
}
