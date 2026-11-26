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
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorSpaceMembers,
  juniorSpaces,
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

/** True when the viewer is a materialized participant on this root conversation. */
export function conversationHasParticipantUser(userId: string): SQL {
  return exists(memberParticipantRow({ userId }));
}

function privateSpaceIds() {
  return getDb()
    .select({ id: juniorSpaces.id })
    .from(juniorSpaces)
    .where(eq(juniorSpaces.visibility, "private"));
}

/** The private Spaces that the person is a member of. */
function memberPrivateSpaceIds(member: ConversationMember) {
  const rows = getDb()
    .select({ id: juniorSpaceMembers.spaceId })
    .from(juniorSpaceMembers)
    .innerJoin(juniorSpaces, eq(juniorSpaces.id, juniorSpaceMembers.spaceId));
  const isPrivate = eq(juniorSpaces.visibility, "private");
  return "userId" in member
    ? rows.where(and(eq(juniorSpaceMembers.userId, member.userId), isPrivate))
    : rows
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorSpaceMembers.userId))
        .where(
          and(eq(juniorUsers.primaryEmailNormalized, member.email), isPrivate),
        );
}

const spaceLead = alias(juniorConversations, "membership_space_lead");

/**
 * The Leads of some Spaces, as one array. Every Conversation in a Space has
 * its Lead as its tree root, so this finds the Space of every row. The
 * uncorrelated `array(...)` runs once as an InitPlan, which Postgres charges
 * once, where a hashed subquery in a filter is charged on each index probe.
 */
function spaceLeadArray(spaceIds: SQLWrapper): SQL {
  const leads = getDb()
    .select({ id: spaceLead.conversationId })
    .from(spaceLead)
    .where(
      and(eq(spaceLead.kind, "lead"), inArray(spaceLead.spaceId, spaceIds)),
    );
  return sql`array(${leads})`;
}

/** True when the outer conversation is in no private Space. */
function outsidePrivateSpaces(): SQL {
  return or(
    isNull(juniorConversations.rootConversationId),
    sql`${juniorConversations.rootConversationId} <> all(${spaceLeadArray(privateSpaceIds())})`,
  )!;
}

/** True when the outer conversation is in a private Space of the person. */
function inMemberPrivateSpace(member: ConversationMember): SQL {
  return sql`${juniorConversations.rootConversationId} = any(${spaceLeadArray(memberPrivateSpaceIds(member))})`;
}

/**
 * True when the outer root conversation is in no Space, in a public Space,
 * or in a private Space that the person is a member of. A participant who
 * leaves a private Space no longer reads its roots.
 */
export function rootSpaceReadableBy(member: ConversationMember): SQL {
  return or(outsidePrivateSpaces(), inMemberPrivateSpace(member))!;
}

/**
 * True when the viewer may find the outer root conversation by a link to
 * it: the root is public, or the viewer is a Participant. A root in a
 * private Space is visible only to the Space's members, and to all of them.
 */
export function rootVisibleToViewer(viewerUserId: string | undefined): SQL {
  return or(
    and(
      outsidePrivateSpaces(),
      or(
        isPublicConversation(juniorConversations),
        viewerUserId ? conversationHasParticipantUser(viewerUserId) : undefined,
      ),
    ),
    viewerUserId ? inMemberPrivateSpace({ userId: viewerUserId }) : undefined,
  )!;
}

/**
 * True when the person is a Participant of the conversation. Feeds filter
 * with this id set instead of a per-row membership check, so Postgres reads
 * only that person's conversations, not every root.
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
  return inArray(juniorConversations.conversationId, memberRoots);
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
