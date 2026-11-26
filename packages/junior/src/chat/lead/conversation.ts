/**
 * The Lead of one Space: the Space's top-level Conversation that finds,
 * starts, and steers the Space's other Conversations. It has the Space's
 * visibility and name. Its members talk to it, and a unique index keeps one
 * Lead for each Space.
 */
import { and, eq } from "drizzle-orm";
import type { Conversation } from "@/chat/conversations/store";
import { getConversationStore, getDb } from "@/chat/db";
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
