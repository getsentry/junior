import { asc, eq, inArray } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { ActorIdentity } from "../schema/conversation";

const identityColumns = {
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
): ActorIdentity | undefined {
  const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
  const email = row.email?.trim() || row.userEmail?.trim();
  const slack = row.provider === "slack";
  const participant = {
    ...(email ? { email } : undefined),
    ...(fullName ? { fullName } : undefined),
    ...(slack && row.providerSubjectId
      ? { slackUserId: row.providerSubjectId }
      : undefined),
    ...(slack && row.handle ? { slackUserName: row.handle } : undefined),
  };
  return Object.keys(participant).length > 0 ? participant : undefined;
}

/** Read actor identities in first-appearance order for each Conversation. */
export async function readConversationParticipants(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ActorIdentity[]>> {
  if (conversationIds.length === 0) return new Map();

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
        inArray(juniorConversationEvents.conversationId, [...conversationIds]),
      )
      .orderBy(
        asc(juniorConversationEvents.conversationId),
        asc(juniorConversationEvents.actorIdentityId),
        asc(juniorConversationEvents.seq),
      ),
  ]);

  const ordered = new Map<
    string,
    { identities: ActorIdentity[]; keys: Set<string> }
  >();
  const add = (conversationId: string, row: ParticipantIdentityRow) => {
    const participant = participantIdentity(row);
    if (!participant) return;
    const group = ordered.get(conversationId) ?? {
      identities: [],
      keys: new Set<string>(),
    };
    const key = row.userId
      ? `user:${row.userId}`
      : `identity:${row.identityId}`;
    if (!group.keys.has(key)) {
      group.keys.add(key);
      group.identities.push(participant);
    }
    ordered.set(conversationId, group);
  };

  for (const row of rootRows) add(row.conversationId, row);
  for (const row of eventRows.sort((left, right) => left.seq - right.seq)) {
    add(row.conversationId, row);
  }
  return new Map(
    [...ordered].map(([conversationId, group]) => [
      conversationId,
      group.identities,
    ]),
  );
}
