import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  not,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";

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

/** Read personal pin marks for a bounded set of conversation roots. */
export async function conversationViewerMarks(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  subject: ConversationMember | undefined,
): Promise<Map<string, ConversationViewerMarks>> {
  if (!subject || conversationIds.length === 0) return new Map();
  const marked = and(
    inArray(juniorConversationParticipants.rootConversationId, [
      ...conversationIds,
    ]),
    isNotNull(juniorConversationParticipants.pinnedAt),
  );
  const query = db
    .select({
      pinnedAt: juniorConversationParticipants.pinnedAt,
      pinPosition: juniorConversationParticipants.pinPosition,
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
  const rows =
    "userId" in subject
      ? await query.where(
          and(
            eq(juniorConversationParticipants.userId, subject.userId),
            marked,
          ),
        )
      : await query
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorConversationParticipants.userId),
          )
          .where(
            and(eq(juniorUsers.primaryEmailNormalized, subject.email), marked),
          );
  return new Map(
    rows.flatMap((row) => {
      const marks = viewerMarksFromParticipant(row);
      return marks ? [[row.rootConversationId, marks] as const] : [];
    }),
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
