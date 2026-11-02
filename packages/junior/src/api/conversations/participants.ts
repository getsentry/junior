import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  identityAvatarUrl,
  readUserAvatarUrls,
} from "@/chat/identities/avatar";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { ActorIdentity } from "../schema/conversation";

const identityColumns = {
  avatarUrl: juniorIdentities.avatarUrl,
  displayName: juniorIdentities.displayName,
  email: juniorIdentities.email,
  handle: juniorIdentities.handle,
  identityId: juniorIdentities.id,
  provider: juniorIdentities.provider,
  providerSubjectId: juniorIdentities.providerSubjectId,
  userDisplayName: juniorUsers.displayName,
  userEmail: juniorUsers.primaryEmail,
  userId: juniorIdentities.userId,
};

type ParticipantIdentityRow = {
  avatarUrl: string | null;
  displayName: string | null;
  email: string | null;
  handle: string | null;
  identityId: string;
  provider: string;
  providerSubjectId: string;
  userDisplayName: string | null;
  userEmail: string | null;
  userId: string | null;
};

function participantIdentity(
  row: ParticipantIdentityRow,
  userAvatarUrls: ReadonlyMap<string, string>,
): ActorIdentity | undefined {
  const avatarUrl = identityAvatarUrl(row, userAvatarUrls);
  const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
  const email = row.email?.trim() || row.userEmail?.trim();
  const slack = row.provider === "slack";
  const participant = {
    ...(avatarUrl ? { avatarUrl } : undefined),
    ...(email ? { email } : undefined),
    ...(fullName ? { fullName } : undefined),
    ...(slack && row.providerSubjectId
      ? { slackUserId: row.providerSubjectId }
      : undefined),
    ...(slack && row.handle ? { slackUserName: row.handle } : undefined),
  };
  return Object.keys(participant).length > 0 ? participant : undefined;
}

type ConversationParticipantRow = ParticipantIdentityRow & {
  conversationId: string;
};

// One person can write from several Identities, such as Slack and web.
function participantKey(row: { identityId: string; userId: string | null }) {
  return row.userId ? `user:${row.userId}` : `identity:${row.identityId}`;
}

// Read the root actor and each message author, in first-appearance order.
async function readParticipantRows(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<ConversationParticipantRow[]> {
  const [rootRows, eventRows] = await Promise.all([
    db
      .select({
        conversationId: juniorConversations.conversationId,
        ...identityColumns,
      })
      .from(juniorConversations)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(inArray(juniorConversations.conversationId, [...conversationIds])),
    db
      .selectDistinctOn(
        [
          juniorConversationEvents.conversationId,
          juniorConversationEvents.actorIdentityId,
        ],
        {
          conversationId: juniorConversationEvents.conversationId,
          seq: juniorConversationEvents.seq,
          ...identityColumns,
        },
      )
      .from(juniorConversationEvents)
      .innerJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversationEvents.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(
        and(
          inArray(juniorConversationEvents.conversationId, [
            ...conversationIds,
          ]),
          // System Messages, such as events, carry the system Identity.
          ne(juniorIdentities.kind, "system"),
        ),
      )
      .orderBy(
        asc(juniorConversationEvents.conversationId),
        asc(juniorConversationEvents.actorIdentityId),
        asc(juniorConversationEvents.seq),
      ),
  ]);
  return [
    ...rootRows,
    ...eventRows.sort((left, right) => left.seq - right.seq),
  ];
}

// Group rows by Conversation, then by person, in first-appearance order.
async function groupParticipants(
  db: JuniorDatabase,
  rows: readonly ConversationParticipantRow[],
): Promise<Map<string, Map<string, ActorIdentity>>> {
  const userAvatarUrls = await readUserAvatarUrls(
    db,
    rows.flatMap((row) => (row.userId ? [row.userId] : [])),
  );
  const groups = new Map<string, Map<string, ActorIdentity>>();
  for (const row of rows) {
    const participant = participantIdentity(row, userAvatarUrls);
    if (!participant) continue;
    const group = groups.get(row.conversationId) ?? new Map();
    const key = participantKey(row);
    if (!group.has(key)) group.set(key, participant);
    groups.set(row.conversationId, group);
  }
  return groups;
}

/** Read actor identities in first-appearance order for each Conversation. */
export async function readConversationParticipants(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ActorIdentity[]>> {
  if (conversationIds.length === 0) return new Map();
  const groups = await groupParticipants(
    db,
    await readParticipantRows(db, conversationIds),
  );
  return new Map(
    [...groups].map(([conversationId, group]) => [
      conversationId,
      [...group.values()],
    ]),
  );
}

/**
 * Read the participants of one Conversation, and each of them by each of
 * their Identity ids. A person is listed under every Identity of their
 * user, so a pending Message from another provider resolves too.
 */
export async function readConversationAuthors(
  db: JuniorDatabase,
  conversationId: string,
): Promise<{
  authors: Record<string, ActorIdentity>;
  participants: ActorIdentity[];
}> {
  const rows = await readParticipantRows(db, [conversationId]);
  const userIds = [
    ...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : []))),
  ];
  const [groups, userIdentities] = await Promise.all([
    groupParticipants(db, rows),
    userIds.length > 0
      ? db
          .select({
            identityId: juniorIdentities.id,
            userId: juniorIdentities.userId,
          })
          .from(juniorIdentities)
          .where(inArray(juniorIdentities.userId, userIds))
      : [],
  ]);
  const group = groups.get(conversationId) ?? new Map<string, ActorIdentity>();
  const authors: Record<string, ActorIdentity> = {};
  for (const row of [...rows, ...userIdentities]) {
    const participant = group.get(participantKey(row));
    if (participant) authors[row.identityId] = participant;
  }
  return { authors, participants: [...group.values()] };
}
