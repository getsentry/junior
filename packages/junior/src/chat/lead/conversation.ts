/**
 * The Lead of one Space: the Space's top-level Conversation that finds,
 * starts, and steers the Space's other Conversations. It has the Space's
 * visibility and name. Its members talk to it, and a unique index keeps one
 * Lead for each Space.
 */
import { and, eq } from "drizzle-orm";
import { messagesNeedSpaceMembership } from "@/chat/conversations/kind-behavior";
import type { Conversation } from "@/chat/conversations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { readSpace, type Space } from "@/chat/spaces/store";
import { juniorConversations } from "@/db/schema";

/**
 * Return the Lead of a Space that the caller read. A Space is readable only
 * with its Lead, so a missing Lead is a failure.
 */
export async function getSpaceLead(spaceId: string): Promise<Conversation> {
  const [row] = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.kind, "lead"),
        eq(juniorConversations.spaceId, spaceId),
      ),
    )
    .limit(1);
  const lead = row
    ? await getConversationStore().get({ conversationId: row.conversationId })
    : undefined;
  if (!lead) throw new Error("The Space has no Lead");
  return lead;
}

/** Return the id of a Lead's Space. Returns nothing for a Conversation that is not a Lead. */
export async function readLeadSpace(
  conversationId: string,
): Promise<Pick<Space, "id"> | undefined> {
  const [row] = await getDb()
    .select({ id: juniorConversations.spaceId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, conversationId),
        eq(juniorConversations.kind, "lead"),
      ),
    )
    .limit(1);
  return row?.id ? { id: row.id } : undefined;
}

/**
 * Return whether a person may send a Message to a Conversation now, as far
 * as its Space decides: only members of a Space that is not archived message
 * its Lead. Every other Conversation leaves the decision to its access rules.
 */
export async function spaceTakesMessagesFrom(
  conversation: Pick<Conversation, "kind" | "spaceId">,
  userId: string,
): Promise<boolean> {
  if (
    !messagesNeedSpaceMembership(conversation.kind) ||
    !conversation.spaceId
  ) {
    return true;
  }
  const space = await readSpace(userId, conversation.spaceId);
  return Boolean(space?.viewerIsMember && !space.archivedAt);
}
