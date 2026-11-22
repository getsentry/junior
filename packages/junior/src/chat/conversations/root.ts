import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";

/**
 * Read the root Conversation of a Conversation tree and its root Actor
 * Identity id. A root is its own root. A child stores no root Actor of its
 * own that counts, so this reads the root row.
 */
export async function readConversationRoot(conversationId: string): Promise<
  | {
      conversationId: string;
      actorIdentityId?: string;
    }
  | undefined
> {
  const root = alias(juniorConversations, "root");
  const [row] = await getDb()
    .select({
      conversationId: root.conversationId,
      actorIdentityId: root.actorIdentityId,
    })
    .from(juniorConversations)
    .innerJoin(
      root,
      eq(
        root.conversationId,
        sql`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`,
      ),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  if (!row) return undefined;
  return {
    conversationId: row.conversationId,
    ...(row.actorIdentityId
      ? { actorIdentityId: row.actorIdentityId }
      : undefined),
  };
}
