import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  notExists,
  or,
  type SQL,
} from "drizzle-orm";
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

/** True when one user's personal feed has archived this root. */
export function conversationArchivedForUser(userId: string): SQL {
  const archive = getDb()
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
        isNotNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return exists(archive);
}

/** True when one user's personal feed has not archived this root. */
export function conversationNotArchivedForUser(userId: string): SQL {
  const archive = getDb()
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
        isNotNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return notExists(archive);
}

/** True when one primary-email user's personal feed has archived this root. */
export function conversationArchivedForEmail(email: string): SQL {
  const archive = getDb()
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
        isNotNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return exists(archive);
}

/** True when one primary-email user's personal feed has not archived this root. */
export function conversationNotArchivedForEmail(email: string): SQL {
  const archive = getDb()
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
        isNotNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return notExists(archive);
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

/** Read personal archive timestamps for a bounded set of conversation roots. */
export async function conversationArchiveTimes(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  subject: { email: string } | { userId: string } | undefined,
): Promise<Map<string, number>> {
  if (!subject || conversationIds.length === 0) return new Map();
  const query = db
    .select({
      archivedAt: juniorConversationParticipants.archivedAt,
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants);
  const rows =
    "userId" in subject
      ? await query.where(
          and(
            eq(juniorConversationParticipants.userId, subject.userId),
            inArray(juniorConversationParticipants.rootConversationId, [
              ...conversationIds,
            ]),
            isNotNull(juniorConversationParticipants.archivedAt),
          ),
        )
      : await query
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorConversationParticipants.userId),
          )
          .where(
            and(
              eq(juniorUsers.primaryEmailNormalized, subject.email),
              inArray(juniorConversationParticipants.rootConversationId, [
                ...conversationIds,
              ]),
              isNotNull(juniorConversationParticipants.archivedAt),
            ),
          );
  return new Map(
    rows.flatMap((row) =>
      row.archivedAt
        ? [[row.rootConversationId, row.archivedAt.getTime()] as const]
        : [],
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
