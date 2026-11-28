import { and, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import { touchConversationDetail } from "./detail-version";
import { isPublicConversation } from "./privacy";

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
 * Upsert one linked user as a participant on a root conversation, and
 * return whether they are one now. No-ops and returns false when the
 * identity is missing, unlinked, or not a user. `resubscribe` ends an
 * unsubscribe: the user addressed Junior again. With `message`, only a Slack
 * author is added: on the web and other surfaces a person joins explicitly,
 * so their Message only updates a row that they already have.
 */
export async function recordConversationParticipant(
  executor: JuniorSqlDatabase,
  args: {
    actorIdentityId: string;
    conversationId: string;
    atMs: number;
    message?: boolean;
    resubscribe?: boolean;
  },
): Promise<boolean> {
  const [identity] = await executor
    .db()
    .select({
      kind: juniorIdentities.kind,
      provider: juniorIdentities.provider,
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
  const set = {
    lastMessageAt: sql`greatest(${juniorConversationParticipants.lastMessageAt}, ${at})`,
    ...(args.resubscribe ? { unsubscribedAt: null } : undefined),
  };
  // Each caller bumps the Conversation in the same transaction: event appends
  // carry the touch, and the root upsert sets `detailVersion`. The root needs
  // no bump, because its detail version sums its subtree.
  if (args.message && identity.provider !== "slack") {
    // oxlint-disable-next-line junior/touch-conversation-detail -- callers bump in the same transaction.
    const updated = await executor
      .db()
      .update(juniorConversationParticipants)
      .set(set)
      .where(
        and(
          eq(juniorConversationParticipants.userId, identity.userId),
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
        ),
      )
      .returning({ userId: juniorConversationParticipants.userId });
    return updated.length > 0;
  }
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
      set,
    });
  return true;
}

/** Return whether a Conversation is a Space's Lead. */
export async function isLeadConversation(
  db: JuniorDatabase,
  conversationId: string,
): Promise<boolean> {
  const [lead] = await db
    .select({ id: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, conversationId),
        eq(juniorConversations.kind, "lead"),
      ),
    );
  return Boolean(lead);
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

/**
 * Remove a Slack user from the Participants of each private root in a Slack
 * channel, after they leave the channel or someone removes them. The
 * channel decides who reads its private Conversations, so they lose access.
 * A public root keeps them: anyone can read it and Join it.
 */
export async function removeSlackChannelParticipant(
  executor: JuniorSqlDatabase,
  args: { channelId: string; slackUserId: string; teamId: string },
): Promise<void> {
  await executor.transaction(async () => {
    const db = executor.db();
    const users = db
      .select({ userId: juniorIdentities.userId })
      .from(juniorIdentities)
      .where(
        and(
          eq(juniorIdentities.provider, "slack"),
          eq(juniorIdentities.providerTenantId, args.teamId),
          eq(juniorIdentities.providerSubjectId, args.slackUserId),
          isNotNull(juniorIdentities.userId),
        ),
      );
    const roots = db
      .select({ conversationId: juniorConversations.conversationId })
      .from(juniorConversations)
      .innerJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(
          eq(juniorDestinations.provider, "slack"),
          eq(juniorDestinations.providerTenantId, args.teamId),
          eq(juniorDestinations.providerDestinationId, args.channelId),
          isNull(juniorConversations.parentConversationId),
          // Null visibility reads as private.
          or(
            isNull(juniorConversations.visibility),
            not(isPublicConversation(juniorConversations)),
          ),
        ),
      );
    const removed = await db
      .delete(juniorConversationParticipants)
      .where(
        and(
          inArray(juniorConversationParticipants.userId, users),
          inArray(juniorConversationParticipants.rootConversationId, roots),
        ),
      )
      .returning({
        rootConversationId: juniorConversationParticipants.rootConversationId,
      });
    // The root's detail lists its Participants.
    await touchConversationDetail(
      db,
      removed.map((row) => row.rootConversationId),
    );
  });
}
