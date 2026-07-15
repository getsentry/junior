import { eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";

/** Set or clear the dashboard archive marker for one conversation. */
export async function setConversationArchived(args: {
  archived: boolean;
  conversationId: string;
  nowMs?: number;
}): Promise<boolean> {
  const rows = await getDb()
    .update(juniorConversations)
    .set({
      archivedAt: args.archived ? new Date(args.nowMs ?? Date.now()) : null,
    })
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .returning({ conversationId: juniorConversations.conversationId });
  return rows.length > 0;
}
