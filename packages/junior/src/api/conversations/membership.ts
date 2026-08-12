import { and, eq, exists, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";

/** True when the viewer is a materialized participant on this root conversation. */
export function conversationHasParticipantUser(userId: string): SQL {
  const participant = getDb()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(
          juniorConversationParticipants.rootConversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationParticipants.userId, userId),
      ),
    );
  return exists(participant);
}

/**
 * True when a verified primary-email user participates on this root
 * conversation. Used only for the actorEmail feed fallback.
 */
export function conversationHasParticipantEmail(email: string): SQL {
  const participant = getDb()
    .select({
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants)
    .innerJoin(
      juniorUsers,
      eq(juniorUsers.id, juniorConversationParticipants.userId),
    )
    .where(
      and(
        eq(
          juniorConversationParticipants.rootConversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorUsers.primaryEmailNormalized, email),
      ),
    );
  return exists(participant);
}

/** Root-actor ownership or a materialized participant row for the same person. */
export function viewerConversationMembership(args: {
  actorMatch: SQL | undefined;
  participantMatch: SQL | undefined;
}): SQL | undefined {
  if (args.actorMatch && args.participantMatch) {
    return or(args.actorMatch, args.participantMatch);
  }
  return args.actorMatch ?? args.participantMatch;
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
