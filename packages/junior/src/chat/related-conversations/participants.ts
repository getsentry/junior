/**
 * Name who takes part in a related Conversation, so the agent can tell work
 * that the requester already takes part in from work of other people.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationParticipants,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";

// Names per Conversation. The rest only count, to keep the prompt short.
const MAX_NAMES = 10;

/** Who takes part in one root, newest message first. */
export interface RelatedParticipants {
  /** Up to ten names. The requester is `you`, first. */
  names: string[];
  /** Participants past the names, and those with no display name. */
  others: number;
}

/**
 * Return the participants of each root. A root with no participant has no
 * entry.
 */
export async function listRelatedParticipants(
  db: JuniorDatabase,
  args: { requesterUserId: string | undefined; rootConversationIds: string[] },
): Promise<Map<string, RelatedParticipants>> {
  const byRoot = new Map<string, RelatedParticipants>();
  if (args.rootConversationIds.length === 0) return byRoot;
  const rows = await db
    .select({
      identityName: juniorIdentities.displayName,
      rootConversationId: juniorConversationParticipants.rootConversationId,
      userId: juniorConversationParticipants.userId,
      userName: juniorUsers.displayName,
    })
    .from(juniorConversationParticipants)
    .innerJoin(
      juniorUsers,
      eq(juniorUsers.id, juniorConversationParticipants.userId),
    )
    // A person's name often lives only on an Identity, such as Slack.
    .leftJoin(
      juniorIdentities,
      and(
        eq(juniorIdentities.userId, juniorConversationParticipants.userId),
        isNotNull(juniorIdentities.displayName),
      ),
    )
    .where(
      inArray(
        juniorConversationParticipants.rootConversationId,
        args.rootConversationIds,
      ),
    )
    .orderBy(desc(juniorConversationParticipants.lastMessageAt));
  // One row per Identity. Keep the first name of each user, in message order.
  const grouped = new Map<string, Map<string, string | undefined>>();
  for (const row of rows) {
    const users =
      grouped.get(row.rootConversationId) ??
      new Map<string, string | undefined>();
    grouped.set(row.rootConversationId, users);
    users.set(
      row.userId,
      users.get(row.userId) ??
        (row.userName?.trim() || row.identityName?.trim() || undefined),
    );
  }
  for (const [rootConversationId, users] of grouped) {
    const you = users.has(args.requesterUserId ?? "");
    const named = [...users].flatMap(([userId, name]) =>
      userId !== args.requesterUserId && name ? [name] : [],
    );
    const names = [...(you ? ["you"] : []), ...named].slice(0, MAX_NAMES);
    byRoot.set(rootConversationId, {
      names,
      others: users.size - names.length,
    });
  }
  return byRoot;
}
