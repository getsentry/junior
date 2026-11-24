/**
 * Name who takes part in a related Conversation, so the agent can tell work
 * that the requester already takes part in from work of other people.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationParticipants, juniorUsers } from "@/db/schema";

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
      displayName: juniorUsers.displayName,
      rootConversationId: juniorConversationParticipants.rootConversationId,
      userId: juniorConversationParticipants.userId,
    })
    .from(juniorConversationParticipants)
    .innerJoin(
      juniorUsers,
      eq(juniorUsers.id, juniorConversationParticipants.userId),
    )
    .where(
      inArray(
        juniorConversationParticipants.rootConversationId,
        args.rootConversationIds,
      ),
    )
    .orderBy(desc(juniorConversationParticipants.lastMessageAt));
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    grouped.set(row.rootConversationId, [
      ...(grouped.get(row.rootConversationId) ?? []),
      row,
    ]);
  }
  for (const [rootConversationId, participants] of grouped) {
    const you = participants.some((row) => row.userId === args.requesterUserId);
    const named = participants.flatMap((row) =>
      row.userId !== args.requesterUserId && row.displayName
        ? [row.displayName]
        : [],
    );
    const names = [...(you ? ["you"] : []), ...named].slice(0, MAX_NAMES);
    byRoot.set(rootConversationId, {
      names,
      others: participants.length - names.length,
    });
  }
  return byRoot;
}
