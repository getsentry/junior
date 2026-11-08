import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  conversationDescendants,
  readConversationTrees,
  setArchivedAt,
} from "@/chat/conversations/sql/conversation-tree";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ConversationSubscriptionBody,
  ConversationSubscriptionResponse,
} from "../schema/conversation-subscription";
import { readConversationAccessFromSql } from "./access";

/**
 * Subscribe the viewer to a Conversation, or unsubscribe them. A
 * subscription belongs to the root, like a pin. An unsubscribed root leaves
 * the viewer's active feed until they mention Junior in it again, subscribe,
 * or pin it. The participant row stays, so the viewer keeps access.
 *
 * Unsubscribe also clears the viewer's pin. When no subscriber is left, no
 * feed shows the Conversation, so the unsubscribe archives the root and its
 * unarchived descendants for everyone. A later Message restores it.
 */
export async function setConversationSubscription(
  viewer: User,
  conversationId: string,
  body: ConversationSubscriptionBody,
): Promise<ConversationSubscriptionResponse> {
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
  return await executor.transaction(async () => {
    const db = executor.db();
    // The lock orders concurrent unsubscribes, so the last one sees that no
    // subscriber is left.
    const [root] = await db
      .select({
        archivedAt: juniorConversations.archivedAt,
        lastActivityAt: juniorConversations.lastActivityAt,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, rootConversationId))
      .limit(1)
      .for("update");
    if (!root) throwApiError(404, "Conversation not found.");
    const unsubscribedAt = body.subscribed ? null : new Date();
    // The root actor may not have a participant row yet. The detail ETag
    // and the feed version read the subscription on each request.
    // oxlint-disable-next-line junior/touch-conversation-detail -- see above.
    await db
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: root.lastActivityAt,
        rootConversationId,
        unsubscribedAt,
        userId: viewer.id,
      })
      .onConflictDoUpdate({
        target: [
          juniorConversationParticipants.userId,
          juniorConversationParticipants.rootConversationId,
        ],
        set: body.subscribed
          ? { unsubscribedAt }
          : { pinnedAt: null, pinPosition: null, unsubscribedAt },
      });
    if (body.subscribed || root.archivedAt) {
      return {
        archivedAt: root.archivedAt?.toISOString() ?? null,
        subscribed: body.subscribed,
      };
    }
    const [subscriber] = await db
      .select({ userId: juniorConversationParticipants.userId })
      .from(juniorConversationParticipants)
      .where(
        and(
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
          isNull(juniorConversationParticipants.unsubscribedAt),
        ),
      )
      .limit(1);
    if (subscriber) return { archivedAt: null, subscribed: false };
    const tree = await readConversationTrees(db, [rootConversationId]);
    const archivedAt = new Date();
    // Descendants that are already archived keep their own time.
    await setArchivedAt(
      db,
      [
        rootConversationId,
        ...conversationDescendants(tree, rootConversationId)
          .filter((node) => !node.archivedAt)
          .map((node) => node.conversationId),
      ],
      archivedAt,
    );
    return { archivedAt: archivedAt.toISOString(), subscribed: false };
  });
}
