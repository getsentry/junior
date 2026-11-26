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
function memberParticipantRow(
  member: ConversationMember,
  condition?: SQL,
  onRoot: SQL = eq(
    juniorConversationParticipants.rootConversationId,
    juniorConversations.conversationId,
  ),
) {
  const rows = getDb()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
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
 * True when the viewer may find the outer conversation by a link to it: it
 * is public, or the viewer is a Participant of its root. A Space's Lead is
 * the root of all of its work, so its Participants find all of it.
 */
export function rootVisibleToViewer(viewerUserId: string | undefined): SQL {
  return or(
    isPublicConversation(juniorConversations),
    viewerUserId ? inParticipantRoot(viewerUserId) : undefined,
  )!;
}

/**
 * True when the person is a Participant of the outer conversation's root.
 * The uncorrelated `array(...)` runs once as an InitPlan, which Postgres
 * charges once, where a correlated check is charged on each row.
 */
function inParticipantRoot(userId: string): SQL {
  const roots = getDb()
    .select({ id: juniorConversationParticipants.rootConversationId })
    .from(juniorConversationParticipants)
    .where(eq(juniorConversationParticipants.userId, userId));
  return sql`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId}) = any(array(${roots}))`;
}

/**
 * True when the person is a Participant of the root conversation, or of the
 * root whose child it is, such as a Lead's Thread that top-level lists
 * show. Participant rows belong to roots, so a child never matches its own
 * id. Feeds filter with this id set instead of a per-row membership check,
 * so Postgres reads only that person's conversations, not every root.
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
    and(
      isNull(juniorConversations.parentConversationId),
      inArray(juniorConversations.conversationId, memberRoots),
    ),
    inArray(juniorConversations.parentConversationId, memberRoots),
  )!;
}

/**
 * True when the person has not unsubscribed from the conversation, or from
 * the root whose child it is. The active feed uses it, so a conversation
 * that someone else carries on leaves the feed of a person who left it,
 * with the Lead's Threads that top-level lists show.
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
        or(
          eq(
            juniorConversationParticipants.rootConversationId,
            juniorConversations.conversationId,
          ),
          eq(
            juniorConversationParticipants.rootConversationId,
            juniorConversations.parentConversationId,
          ),
        ),
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
