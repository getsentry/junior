import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { isLeadConversation } from "@/chat/conversations/sql/participants";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ConversationInviteBody,
  ConversationInviteResponse,
  ConversationLeaveResponse,
  ConversationSubscriptionBody,
  ConversationSubscriptionResponse,
} from "../schema/conversation-subscription";
import {
  canInviteToConversation,
  leaveEndsAccess,
  readableSlackTeamId,
  readConversationAccessFromSql,
} from "./access";

/*
 * Conversation subscription: archive applies to everyone, so a person drops
 * a shared root from only their own feed by unsubscribing. Entry points act
 * only on the signed-in person or the Turn actor, and only Invite adds
 * another person. The last subscriber's leave archives the tree for
 * everyone; root row locks order it against a concurrent mention or pin.
 */

const NOT_ROOT_MESSAGE =
  "Only a root conversation has a subscription. Change it on the root.";

/** Subscribe the viewer to a root Conversation, or unsubscribe them. */
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
  if (result === "not_participant") {
    throwApiError(404, "Conversation not found.");
  }
  if (result === "not_root") throwApiError(409, NOT_ROOT_MESSAGE);
  return result;
}

/**
 * Subscribe a person to a root Conversation, or unsubscribe them. Every
 * caller passes the person who asked, so nobody changes another person's
 * subscription.
 */
export async function updateConversationSubscription(
  person: User,
  conversationId: string,
  subscribed: boolean,
): Promise<ConversationSubscriptionResponse | "not_participant" | "not_root"> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], person)
  ).get(conversationId);
  // A person joins a public root explicitly. A Message on the web does not
  // add its author.
  const joins = subscribed && access?.visibility === "public";
  if (!access || (!access.isParticipant && !joins)) return "not_participant";
  if (access.rootConversationId !== conversationId) return "not_root";
  const rootConversationId = conversationId;
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Unsubscribes, pins, archives, and Turns in the root itself all lock the
    // root row, so they run one at a time. `no key update` does not block a
    // Turn in a child that adds a participant or child row (a foreign key to
    // the root), so this transaction never waits on a lock that such a Turn
    // waits on, and the two cannot deadlock.
    const [root] = await db
      .select({
        archivedAt: juniorConversations.archivedAt,
        lastActivityAt: juniorConversations.lastActivityAt,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, rootConversationId))
      .for("no key update");
    if (!root) return "not_participant";
    const unsubscribedAt = subscribed ? null : new Date();
    // The detail ETag and the feed version read the subscription on each
    // request.
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
    return {
      archivedAt: await archiveWithoutSubscribers(db, rootConversationId),
      subscribed: false,
    };
  });
}

/**
 * Remove the viewer from a private Conversation's Participants. Only the
 * viewer leaves, so nobody removes another person.
 */
export async function leaveConversation(
  viewer: User,
  conversationId: string,
): Promise<ConversationLeaveResponse> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  const rootConversationId = access?.rootConversationId;
  if (!rootConversationId || !access.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  if (rootConversationId !== conversationId) {
    throwApiError(409, NOT_ROOT_MESSAGE);
  }
  // Where the Conversation is public, or a Slack channel decides who reads
  // it, Leave only takes it out of the viewer's feed.
  if (!leaveEndsAccess(access)) {
    const result = await updateConversationSubscription(
      viewer,
      conversationId,
      false,
    );
    if (typeof result === "string") {
      throwApiError(404, "Conversation not found.");
    }
    return { archivedAt: result.archivedAt };
  }
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Lock the root as an unsubscribe does, so a last-subscriber archive
    // and a concurrent Invite are ordered.
    const [root] = await db
      .select({ archivedAt: juniorConversations.archivedAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, rootConversationId))
      .for("no key update");
    if (!root) throwApiError(404, "Conversation not found.");
    await db
      .delete(juniorConversationParticipants)
      .where(
        and(
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
          eq(juniorConversationParticipants.userId, viewer.id),
        ),
      );
    // The root's detail lists its Participants.
    await touchConversationDetail(db, [rootConversationId]);
    if (root.archivedAt) return { archivedAt: root.archivedAt.toISOString() };
    return {
      archivedAt: await archiveWithoutSubscribers(db, rootConversationId),
    };
  });
}

/**
 * Archive the tree for everyone when no Participant still has it in their
 * feed. Returns the archive time, or null when a subscriber remains. Runs
 * under the root's row lock. A Lead's tree is its whole Space, which only
 * a Space archive ends, so it never archives here.
 */
async function archiveWithoutSubscribers(
  db: JuniorDatabase,
  rootConversationId: string,
): Promise<string | null> {
  if (await isLeadConversation(db, rootConversationId)) return null;
  if (await hasSubscriber(db, rootConversationId)) return null;
  const archivedAt = new Date();
  // Archive the root and each descendant that is not archived, so an
  // archived descendant keeps its own time. The guard runs on the latest
  // row, so a descendant that a Turn restores while this waits is archived
  // too. A child that a Turn adds while this runs stays unarchived, and its
  // next Message restores the root.
  await setArchivedAt(
    db,
    inConversationTree(rootConversationId),
    archivedAt,
    isNull(juniorConversations.archivedAt),
  );
  // The archive waited for each Turn in a child that held its row. Such a
  // Turn can subscribe someone, so check again and undo the archive if it
  // did. A Turn that starts later sees the archive and restores it.
  if (await hasSubscriber(db, rootConversationId)) {
    // Restore only what this archive wrote.
    await setArchivedAt(
      db,
      inConversationTree(rootConversationId),
      null,
      eq(juniorConversations.archivedAt, archivedAt),
    );
    return null;
  }
  return archivedAt.toISOString();
}

/**
 * Invite a User into a Conversation's feed. An existing Participant keeps
 * their row, so Invite does not undo their unsubscribe. An archived root
 * refuses Invite, because a restore is for everyone.
 */
export async function inviteToConversation(
  viewer: User,
  conversationId: string,
  body: ConversationInviteBody,
): Promise<ConversationInviteResponse> {
  const conversation = await readInvitableConversation(viewer, conversationId);
  if (!conversation) throwApiError(404, "Conversation not found.");
  const [user] = await getDb()
    .select({ id: juniorUsers.id })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, body.userId))
    .limit(1);
  if (!user) throwApiError(404, "Person not found.");
  const added = await addInvitedParticipants(
    conversation.rootConversationId,
    [user.id],
    { refuseArchived: true },
  );
  return { added: added > 0 };
}

/**
 * The root, visibility, and Slack workspace of a Conversation that the
 * viewer may Invite people to.
 */
async function readInvitableConversation(
  viewer: User,
  conversationId: string,
): Promise<
  | {
      rootConversationId: string;
      slackTeamId: string | undefined;
      visibility: "private" | "public";
    }
  | undefined
> {
  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], viewer)
  ).get(conversationId);
  const rootConversationId = access?.rootConversationId;
  if (!rootConversationId || !canInviteToConversation(access)) {
    // A reader of a public root may Invite once they Join it.
    if (access?.canViewPrivateContent && !access.isParticipant) {
      throwApiError(
        403,
        "Only participants can invite people. Join the conversation first.",
      );
    }
    return undefined;
  }
  return {
    rootConversationId,
    slackTeamId: readableSlackTeamId(access),
    visibility: access.visibility === "public" ? "public" : "private",
  };
}

/** Add each User as a subscribed Participant of the root. */
async function addInvitedParticipants(
  rootConversationId: string,
  userIds: readonly string[],
  options: { refuseArchived: boolean },
): Promise<number> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Lock the root as an unsubscribe does, so a last-subscriber archive
    // either sees these subscribers or happens before them.
    const [root] = await db
      .select({
        archivedAt: juniorConversations.archivedAt,
        lastActivityAt: juniorConversations.lastActivityAt,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, rootConversationId))
      .for("no key update");
    if (!root) throwApiError(404, "Conversation not found.");
    if (options.refuseArchived && root.archivedAt) {
      throwApiError(409, "Conversation is archived.");
    }
    const added = await db
      .insert(juniorConversationParticipants)
      .values(
        userIds.map((userId) => ({
          lastMessageAt: root.lastActivityAt,
          rootConversationId,
          unsubscribedAt: null,
          userId,
        })),
      )
      .onConflictDoNothing()
      .returning({ userId: juniorConversationParticipants.userId });
    // The root's detail lists its Participants.
    if (added.length > 0) {
      await touchConversationDetail(db, [rootConversationId]);
    }
    return added.length;
  });
}

/** True when an active Participant still has the root in their feed. */
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
  return Boolean(subscriber);
}

function inConversationTree(rootConversationId: string) {
  return sql`(${eq(juniorConversations.conversationId, rootConversationId)} or ${eq(juniorConversations.rootConversationId, rootConversationId)})`;
}
