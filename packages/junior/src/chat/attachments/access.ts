import { eq } from "drizzle-orm";
import { canReadConversation } from "@/api/conversations/access";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";
import { type AttachmentRecord, readLiveAttachment } from "./store";

/**
 * Load one live attachment that work in `conversationId` may read: its own,
 * or one in a Conversation that `canReadConversation` allows, such as its
 * parent. Returns null when the attachment is missing or not readable, so a
 * caller gives one error for both.
 */
export async function readAccessibleAttachment(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
}): Promise<AttachmentRecord | null> {
  const [row] = await args.db
    .db()
    .select({ conversationId: juniorAttachments.conversationId })
    .from(juniorAttachments)
    .where(eq(juniorAttachments.id, args.attachmentId));
  if (!row) return null;
  if (
    row.conversationId !== args.conversationId &&
    !(await canReadConversation(
      args.db.db(),
      args.conversationId,
      row.conversationId,
    ))
  ) {
    return null;
  }
  return await readLiveAttachment({
    attachmentId: args.attachmentId,
    conversationId: row.conversationId,
    db: args.db,
  });
}
