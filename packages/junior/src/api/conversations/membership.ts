import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";
import { isPublicConversation } from "@/chat/conversations/sql/privacy";

/** A person by User id, or by primary email when no User is known. */
export type ConversationMember = { userId: string } | { email: string };

/**
 * Select the person's participant row on the outer `juniorConversations`
 * root, with an optional extra condition.
 */
function memberParticipantRow(member: ConversationMember, condition?: SQL) {
  const rows = getDb()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
  const onRoot = eq(
    juniorConversationParticipants.rootConversationId,
    juniorConversations.conversationId,
  );
  return "userId" in member
    ? rows.where(
        and(
          onRoot,
          eq(juniorConversationParticipants.userId, member.userId),
          condition,
        ),
      )
    : rows
        .innerJoin(
          juniorUsers,
          eq(juniorUsers.id, juniorConversationParticipants.userId),
        )
        .where(
          and(
            onRoot,
            eq(juniorUsers.primaryEmailNormalized, member.email),
            condition,
          ),
        );
}

/**
 * True when the outer conversation is in a tree that the person is a
 * Participant of. In a Space the Lead is the root, so this holds for every
 * Conversation of each Space that the person is a member of.
 */
function inParticipantTree(member: ConversationMember): SQL {
  const rows = getDb()
    .select({ id: juniorConversationParticipants.rootConversationId })
    .from(juniorConversationParticipants);
  const roots =
    "userId" in member
      ? rows.where(eq(juniorConversationParticipants.userId, member.userId))
      : rows
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorConversationParticipants.userId),
          )
          .where(eq(juniorUsers.primaryEmailNormalized, member.email));
  return sql`${juniorConversations.rootConversationId} = any(array(${roots}))`;
}

/**
 * True when the person may read the outer conversation: it is public, or
 * they are a Participant of its tree. A Participant row on a Conversation
 * that has a parent grants nothing, the same as in `access.ts`, so a
 * Conversation moved into a Space does not stay readable to its old
 * Participants.
 */
export function rootVisibleToViewer(viewerUserId: string | undefined): SQL {
  if (!viewerUserId) return isPublicConversation(juniorConversations);
  const member = { userId: viewerUserId };
  return or(
    isPublicConversation(juniorConversations),
    and(
      isNull(juniorConversations.parentConversationId),
      exists(memberParticipantRow(member)),
    ),
    inParticipantTree(member),
  )!;
}

/**
 * `rootVisibleToViewer` for a feed row that `conversationIsMemberRoot`
 * already matched. A root that it matched has the person's Participant row,
 * so only a child needs the tree check.
 */
export function feedRowReadableBy(member: ConversationMember): SQL {
  return or(
    isPublicConversation(juniorConversations),
    isNull(juniorConversations.parentConversationId),
    inParticipantTree(member),
  )!;
}

/**
 * True when the person is a Participant of the conversation, or of the Lead
 * whose child it is, since a Lead's Participants are its Space's members.
 * Feeds filter with this id set instead of a per-row membership check, so
 * Postgres reads only that person's conversations, not every root.
 */
export function conversationIsMemberRoot(member: ConversationMember): SQL {
  const participating = getDb()
    .select({
      conversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
  const memberRoots =
    "userId" in member
      ? participating.where(
          eq(juniorConversationParticipants.userId, member.userId),
        )
      : participating
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorConversationParticipants.userId),
          )
          .where(eq(juniorUsers.primaryEmailNormalized, member.email));
  // Top-level filters keep only a parent match whose parent is a Lead.
  return or(
    inArray(juniorConversations.conversationId, memberRoots),
    inArray(juniorConversations.parentConversationId, memberRoots),
  )!;
}

/**
 * True when the person has not unsubscribed from the conversation. The
 * active feed uses it, so a conversation that someone else carries on
 * leaves the feed of a person who left it.
 */
export function conversationIsNotUnsubscribedRoot(
  member: ConversationMember,
): SQL {
  // An anti-join keeps the feed plan driven by the person's member roots, so
  // Postgres does not scan every root. The partial `unsubscribed` index
  // holds only unsubscribed rows, so the anti-join stays cheap.
  return not(
    exists(
      memberParticipantRow(
        member,
        isNotNull(juniorConversationParticipants.unsubscribedAt),
      ),
    ),
  );
}

/** One person's pin marks on a conversation root. */
export type ConversationViewerMarks = {
  pinnedAtMs?: number;
  pinPosition?: number;
};

/**
 * Read the roots among a bounded set where one person is a Participant, each
 * with their pin marks. An unpinned root maps to empty marks.
 */
export async function readMemberParticipants(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  member: ConversationMember | undefined,
): Promise<Map<string, ConversationViewerMarks>> {
  if (!member || conversationIds.length === 0) return new Map();
  const listed = inArray(juniorConversationParticipants.rootConversationId, [
    ...conversationIds,
  ]);
  const query = db
    .select({
      pinnedAt: juniorConversationParticipants.pinnedAt,
      pinPosition: juniorConversationParticipants.pinPosition,
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
  const rows =
    "userId" in member
      ? await query.where(
          and(eq(juniorConversationParticipants.userId, member.userId), listed),
        )
      : await query
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorConversationParticipants.userId),
          )
          .where(
            and(eq(juniorUsers.primaryEmailNormalized, member.email), listed),
          );
  return new Map(
    rows.map((row) => [
      row.rootConversationId,
      viewerMarksFromParticipant(row) ?? {},
    ]),
  );
}

/** Project one participant row into marks, or undefined when it has none. */
export function viewerMarksFromParticipant(row: {
  pinnedAt: Date | null;
  pinPosition: number | null;
}): ConversationViewerMarks | undefined {
  if (!row.pinnedAt) return undefined;
  return {
    pinnedAtMs: row.pinnedAt.getTime(),
    ...(row.pinPosition !== null
      ? { pinPosition: row.pinPosition }
      : undefined),
  };
}

/** True when one user pinned this root. Feeds sort these rows first. */
export function conversationPinnedForUser(userId: string): SQL {
  return exists(
    memberParticipantRow(
      { userId },
      isNotNull(juniorConversationParticipants.pinnedAt),
    ),
  );
}

/** Find which of the supplied roots include the linked viewer as a participant. */
export async function conversationIdsWithParticipantUser(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  userId: string,
): Promise<Set<string>> {
  if (conversationIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(juniorConversationParticipants.userId, userId),
        inArray(juniorConversationParticipants.rootConversationId, [
          ...conversationIds,
        ]),
      ),
    );
  return new Set(rows.map((row) => row.rootConversationId));
}
