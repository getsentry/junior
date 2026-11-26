import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import {
  isLeadConversation,
  readMentionedUserIds,
  resolveRootConversationId,
} from "@/chat/conversations/sql/participants";
import { slackMentionedUserIds } from "@/chat/slack/mrkdwn";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
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
 *   they post in it, because their first Turn adds their Participant row.
 * - Given an archived root, when a person restores it (any Message that
 *   restores an archive, or Unarchive), then that person is subscribed
 *   again. A restored root never sits in no feed.
 * - Given a Turn, when the agent changes the subscription with its tool,
 *   then only the person who started the Turn changes, in the current
 *   Conversation. The dashboard conversation menu, the agent tool, and the
 *   MCP tool act only on the signed-in person or the Turn actor. No argument
 *   of theirs names a person.
 * - Given a public Conversation that a person can add Messages to, when
 *   they Invite a person they mention, or send a dashboard or Slack Message
 *   that mentions them, then that person becomes a subscribed Participant.
 *   A dashboard Message adds them when it is accepted. Any Message adds them
 *   when it starts or joins a Turn, like its author. This is the only way to
 *   subscribe another person. It gives no access: anyone can already read a
 *   public Conversation and join it by posting.
 * - Given a private Conversation, when a Participant Invites a person, then
 *   that person becomes a Participant and can read it. Only Invite does
 *   this: a mention in a Message adds nobody, so sharing private content
 *   is always an explicit act. In a private Space the root is its Lead, so
 *   Invite adds a member, as a member can on the Space. A Slack-backed
 *   private Conversation follows its Slack channel, so it refuses Invite,
 *   with the same error as a missing Conversation.
 * - Given a Participant, when they Leave, then they unsubscribe. In a
 *   private Conversation with its own Participant list, their row is also
 *   deleted, so they lose access until someone Invites them again.
 *   Elsewhere they keep access and can subscribe again. Nobody removes
 *   another person. When they were the last subscriber, the root and its
 *   unarchived descendants are archived for everyone.
 * - Given any Invite, an archived root refuses it, because no
 *   feed shows it and a restore is for everyone. A Message that mentions
 *   someone in an archived root still adds them, because that Message
 *   restores the root. The mention names a Slack user of the Conversation's
 *   workspace. An existing Participant keeps their row, so Invite does not
 *   undo their unsubscribe. Nobody can unsubscribe another person.
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
 *   (`archivableRow`), and the entry points: this module's HTTP routes,
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
    if (!root) return undefined;
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
 * Remove the viewer from a private Conversation's Participants, for the HTTP
 * API. The contract is in the comment above. Only the viewer leaves, so
 * nobody removes another person.
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
  // Where the Conversation is public, or a Slack channel decides who reads
  // it, Leave only takes it out of the viewer's feed.
  if (!leaveEndsAccess(access)) {
    const result = await updateConversationSubscription(
      viewer,
      conversationId,
      false,
    );
    if (!result) throwApiError(404, "Conversation not found.");
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
    // A private Space with no members has nobody who can read or restore
    // it, so its last member stays, as `leaveSpace` does.
    if (await isLeadConversation(db, rootConversationId)) {
      const members = await db
        .select({ userId: juniorConversationParticipants.userId })
        .from(juniorConversationParticipants)
        .where(
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
        )
        .limit(2);
      // A Leave that raced another Leave by the same person finds only the
      // other member, and its delete changes nothing.
      if (members.length === 1 && members[0]!.userId === viewer.id) {
        throwApiError(409, "The last member can't leave a private Space.");
      }
    }
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
 * Invite a mentioned person into a Conversation's feed, for the HTTP API. The contract is in the comment above. `added` is false when the
 * person was already a Participant.
 */
export async function inviteToConversation(
  viewer: User,
  conversationId: string,
  body: ConversationInviteBody,
): Promise<ConversationInviteResponse> {
  const conversation = await readInvitableConversation(viewer, conversationId);
  if (!conversation) throwApiError(404, "Conversation not found.");
  const [userId] = await readMentionedUserIds(
    getSqlExecutor(),
    [body.slackUserId],
    conversation.slackTeamId,
  );
  if (!userId) throwApiError(404, "Person not found.");
  const added = await addInvitedParticipants(
    conversation.rootConversationId,
    [userId],
    { refuseArchived: true },
  );
  return { added: added > 0 };
}

/**
 * Invite each person that a viewer's Message mentions, as if the viewer
 * chose Invite on each mention. The contract is in the comment above, with
 * one change: an archived root still adds them, because the Message itself
 * restores the root. A mention of someone who is not a User adds nobody.
 */
export async function inviteMentionedPeople(
  viewer: User,
  conversationId: string,
  text: string,
): Promise<void> {
  const slackUserIds = slackMentionedUserIds(text);
  if (slackUserIds.length === 0) return;
  const conversation = await readInvitableConversation(viewer, conversationId);
  // A mention never shares a private Conversation. Only Invite does.
  if (conversation?.visibility !== "public") return;
  const userIds = await readMentionedUserIds(
    getSqlExecutor(),
    slackUserIds,
    conversation.slackTeamId,
  );
  if (userIds.length === 0) return;
  await addInvitedParticipants(conversation.rootConversationId, userIds, {
    refuseArchived: false,
  });
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
    return undefined;
  }
  return {
    rootConversationId,
    slackTeamId: readableSlackTeamId(access),
    visibility: access.visibility === "public" ? "public" : "private",
  };
}

/**
 * Add each User as a subscribed Participant of the root. An existing
 * Participant keeps their row. Returns how many rows it added.
 */
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
