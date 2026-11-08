import { and, eq, inArray, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";

/** Resolve the root conversation id that owns personal-feed membership. */
export async function resolveRootConversationId(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<string> {
  const [row] = await executor
    .db()
    .select({
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  return row?.rootConversationId ?? conversationId;
}

/**
 * Upsert one linked user as a participant on a root conversation.
 * No-ops and returns false when the identity is missing, unlinked, or not a
 * user.
 */
export async function recordConversationParticipant(
  executor: JuniorSqlDatabase,
  args: {
    actorIdentityId: string;
    conversationId: string;
    atMs: number;
  },
): Promise<boolean> {
  const [identity] = await executor
    .db()
    .select({
      kind: juniorIdentities.kind,
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .where(eq(juniorIdentities.id, args.actorIdentityId))
    .limit(1);
  if (!identity?.userId || identity.kind !== "user") {
    return false;
  }

  const rootConversationId = await resolveRootConversationId(
    executor,
    args.conversationId,
  );
  const at = new Date(args.atMs);
  // Each caller bumps the Conversation in the same transaction: event appends
  // carry the touch, and the root upsert sets `detailVersion`. The root needs
  // no bump, because its detail version sums its subtree.
  // oxlint-disable-next-line junior/touch-conversation-detail -- callers bump in the same transaction.
  await executor
    .db()
    .insert(juniorConversationParticipants)
    .values({
      userId: identity.userId,
      rootConversationId,
      lastMessageAt: at,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationParticipants.userId,
        juniorConversationParticipants.rootConversationId,
      ],
      set: {
        lastMessageAt: sql`greatest(${juniorConversationParticipants.lastMessageAt}, excluded.last_message_at)`,
      },
    });
  return true;
}

/** Find which of the supplied root conversations include the linked user. */
export async function rootConversationIdsForParticipant(
  executor: JuniorSqlDatabase,
  args: {
    rootConversationIds: readonly string[];
    userId: string;
  },
): Promise<Set<string>> {
  if (args.rootConversationIds.length === 0) {
    return new Set();
  }
  const rows = await executor
    .db()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(juniorConversationParticipants.userId, args.userId),
        inArray(juniorConversationParticipants.rootConversationId, [
          ...args.rootConversationIds,
        ]),
      ),
    );
  return new Set(rows.map((row) => row.rootConversationId));
}
