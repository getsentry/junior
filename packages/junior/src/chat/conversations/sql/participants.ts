import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { touchConversationDetail } from "./detail-version";

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

/** True when the root of this conversation is archived. */
export async function rootConversationIsArchived(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<boolean> {
  const rootConversationId = await resolveRootConversationId(
    executor,
    conversationId,
  );
  const [row] = await executor
    .db()
    .select({ archivedAt: juniorConversations.archivedAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, rootConversationId))
    .limit(1);
  return Boolean(row?.archivedAt);
}

/**
 * Upsert one linked user as a participant on a root conversation.
 * No-ops and returns false when the identity is missing, unlinked, or not a
 * user. `resubscribe` ends an unsubscribe: the user addressed Junior again.
 */
export async function recordConversationParticipant(
  executor: JuniorSqlDatabase,
  args: {
    actorIdentityId: string;
    conversationId: string;
    atMs: number;
    resubscribe?: boolean;
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
        ...(args.resubscribe ? { unsubscribedAt: null } : undefined),
      },
    });
  return true;
}

/**
 * Add a User as a Participant of each root that their Identity started,
 * when that Identity gets its User after the roots exist. The root write
 * adds a Participant only for an Identity that already has a User.
 */
export async function recordStartedConversationParticipants(
  executor: JuniorSqlDatabase,
  args: { identityId: string; userId: string },
): Promise<void> {
  const roots = await executor
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      lastActivityAt: juniorConversations.lastActivityAt,
    })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.actorIdentityId, args.identityId),
        isNull(juniorConversations.parentConversationId),
      ),
    );
  if (roots.length === 0) return;
  const added = await executor
    .db()
    .insert(juniorConversationParticipants)
    .values(
      roots.map((root) => ({
        userId: args.userId,
        rootConversationId: root.conversationId,
        lastMessageAt: root.lastActivityAt,
      })),
    )
    .onConflictDoNothing()
    .returning({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    });
  await touchConversationDetail(
    executor.db(),
    added.map((row) => row.rootConversationId),
  );
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
