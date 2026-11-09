import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ConversationSubscriptionBody,
  ConversationSubscriptionResponse,
} from "../schema/conversation-subscription";
import { readConversationAccessFromSql } from "./access";

/*
 * Conversation subscription: the owner of this contract.
 *
 * Why: archive applies to everyone. When two people share a Conversation and
 * one hands it off, that person needs a way to drop it from their own feed
 * while the other person keeps working.
 *
 * Behavior. Each scenario has a test in
 * `tests/integration/api/conversations/subscription.test.ts`.
 *
 * - Given two participants, when one unsubscribes, then it leaves only that
 *   person's active feed. The other person's feed does not change.
 * - Given an unsubscribed person, then they keep access. They can open the
 *   Conversation and find it in search and in the archived list.
 * - Given an unsubscribed person, when they post a Message that does not
 *   address Junior (a passive reply in a Slack thread that Junior watches),
 *   or other people keep working, then it stays out of their feed.
 * - Given an unsubscribed person, when they address Junior (a Slack mention,
 *   a Slack DM, or a dashboard Message), then they are subscribed again.
 *   Pin and Subscribe also subscribe them again.
 * - Given the last subscriber, when they unsubscribe, then the root and its
 *   unarchived descendants are archived for everyone. No feed shows it
 *   anymore. The person who started the Conversation is a subscriber before
 *   they post in it.
 * - Given an archived root, when a person restores it (any Message that
 *   restores an archive, or Unarchive), then that person is subscribed
 *   again. A restored root never sits in no feed.
 * - Given a Turn, when the agent changes the subscription with its tool,
 *   then only the person who started the Turn changes, in the current
 *   Conversation. Nobody can subscribe or unsubscribe another person. The
 *   dashboard conversation menu, the agent tool, and the MCP tool act only
 *   on the signed-in person or the Turn actor. No argument names a person.
 *
 * Rules that follow:
 * - A subscription belongs to the root, like a pin. A child id resolves to
 *   its root.
 * - Unsubscribe clears the person's pin. Subscribe does not restore an
 *   archive.
 * - A last-subscriber archive and a concurrent mention or pin are ordered by
 *   row locks, so the mention or pin either keeps the archive from happening
 *   or restores it.
 * - An unsubscribed person does not keep the root from auto-archive, and
 *   their own auto-archive run skips it.
 * - Code: the active feed filter (`conversationIsNotUnsubscribedRoot`), Turn
 *   input membership (`recordTurnInputParticipants`), auto-archive
 *   (`archivableRow`), and the entry points: this module's HTTP route,
 *   `chat/tools/conversation-subscription.ts`, and
 *   `api/mcp/tools/set-conversation-subscription.ts`.
 */

/**
 * Subscribe a person to a Conversation, or unsubscribe them, for the HTTP
 * API. The contract is in the comment above.
 */
export async function setConversationSubscription(
  viewer: User,
  conversationId: string,
  body: ConversationSubscriptionBody,
): Promise<ConversationSubscriptionResponse> {
  const result = await updateConversationSubscription(
    viewer,
    conversationId,
    body.subscribed,
  );
  if (!result) throwApiError(404, "Conversation not found.");
  return result;
}

/**
 * Subscribe a person to a Conversation, or unsubscribe them. Every caller
 * passes the person who asked, so nobody changes another person's
 * subscription. Returns undefined when the person is not a participant.
 */
export async function updateConversationSubscription(
  person: User,
  conversationId: string,
  subscribed: boolean,
): Promise<ConversationSubscriptionResponse | undefined> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    person,
  );
  if (!access.get(conversationId)?.isParticipant) return undefined;
  const executor = getSqlExecutor();
  const rootConversationId = await resolveRootConversationId(
    executor,
    conversationId,
  );
  return await executor.transaction(async () => {
    const db = executor.db();
    // Lock the tree, children before the root. A Turn in a child locks its
    // own row first and the root only to restore it, so this order cannot
    // deadlock with it. A concurrent unsubscribe, mention, or pin either
    // commits first, and the subscriber check below sees it, or it waits,
    // then sees the archive and restores it.
    const tree = await db
      .select({
        archivedAt: juniorConversations.archivedAt,
        conversationId: juniorConversations.conversationId,
        lastActivityAt: juniorConversations.lastActivityAt,
      })
      .from(juniorConversations)
      .where(
        or(
          eq(juniorConversations.conversationId, rootConversationId),
          eq(juniorConversations.rootConversationId, rootConversationId),
        ),
      )
      .orderBy(
        sql`${juniorConversations.conversationId} = ${rootConversationId}`,
      )
      .for("update");
    const root = tree.find(
      (node) => node.conversationId === rootConversationId,
    );
    if (!root) return undefined;
    const unsubscribedAt = subscribed ? null : new Date();
    // The root actor may not have a participant row yet. The detail ETag
    // and the feed version read the subscription on each request.
    // oxlint-disable-next-line junior/touch-conversation-detail -- see above.
    await db
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: root.lastActivityAt,
        rootConversationId,
        unsubscribedAt,
        userId: person.id,
      })
      .onConflictDoUpdate({
        target: [
          juniorConversationParticipants.userId,
          juniorConversationParticipants.rootConversationId,
        ],
        set: subscribed
          ? { unsubscribedAt }
          : { pinnedAt: null, pinPosition: null, unsubscribedAt },
      });
    if (subscribed || root.archivedAt) {
      return {
        archivedAt: root.archivedAt?.toISOString() ?? null,
        subscribed,
      };
    }
    if (await hasSubscriber(db, rootConversationId)) {
      return { archivedAt: null, subscribed: false };
    }
    const archivedAt = new Date();
    // Descendants that are already archived keep their own time.
    await setArchivedAt(
      db,
      tree
        .filter((node) => !node.archivedAt)
        .map((node) => node.conversationId),
      archivedAt,
    );
    return { archivedAt: archivedAt.toISOString(), subscribed: false };
  });
}

/**
 * True when someone still has the root in their feed: a participant who did
 * not unsubscribe, or the root actor before they have a participant row.
 */
async function hasSubscriber(
  db: JuniorDatabase,
  rootConversationId: string,
): Promise<boolean> {
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
  if (subscriber) return true;
  const [rowlessActor] = await db
    .select({ userId: juniorIdentities.userId })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .where(
      and(
        eq(juniorConversations.conversationId, rootConversationId),
        isNotNull(juniorIdentities.userId),
        notExists(
          db
            .select({ userId: juniorConversationParticipants.userId })
            .from(juniorConversationParticipants)
            .where(
              and(
                eq(
                  juniorConversationParticipants.rootConversationId,
                  rootConversationId,
                ),
                eq(
                  juniorConversationParticipants.userId,
                  juniorIdentities.userId,
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return Boolean(rowlessActor);
}
