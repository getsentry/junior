import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getSqlExecutor } from "@/chat/db";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import type { Conversation } from "@/chat/conversations/store";
import { juniorConversations } from "@/db/schema";
import { ownsLocation } from "@/chat/conversations/kind-behavior";
import { topLevelConversation } from "@/chat/conversations/sql/listed";

/** True when the Conversation delivers to a Location of its own. */
export function canPauseConversationDelivery(
  conversation: Pick<
    Conversation,
    "location" | "ownLocation" | "parentConversationId"
  >,
): boolean {
  return ownsLocation(conversation) && conversation.location !== undefined;
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
 * True while this Conversation is detached from its Location. Only a
 * Conversation with its own Location stores the pause, so a child agent
 * reads its root's.
 */
export async function isConversationDeliveryPaused(
  conversationId: string,
): Promise<boolean> {
  const root = alias(juniorConversations, "root");
  const [row] = await getSqlExecutor()
    .db()
    // A Conversation with its own Location, such as a Slack Conversation in
    // a Space, stores its own pause.
    .select({
      pausedAt: sql<Date | null>`coalesce(${juniorConversations.deliveryPausedAt}, ${root.deliveryPausedAt})`,
    })
    .from(juniorConversations)
    .innerJoin(
      root,
      eq(
        root.conversationId,
        sql`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`,
      ),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return Boolean(row?.pausedAt);
}
