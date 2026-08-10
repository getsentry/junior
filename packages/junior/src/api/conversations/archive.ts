import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ArchiveConversationBody,
  ArchiveConversationResponse,
} from "../schema/conversation";

async function archiveIfUnchanged(args: {
  archived: boolean;
  conversationId: string;
  lastSeenAt: string;
}): Promise<"conflict" | "not_found" | "updated"> {
  const db = getDb();
  const rows = await db
    .update(juniorConversations)
    .set({ archivedAt: args.archived ? new Date() : null })
    .where(
      and(
        eq(juniorConversations.conversationId, args.conversationId),
        args.archived
          ? eq(juniorConversations.lastActivityAt, new Date(args.lastSeenAt))
          : isNotNull(juniorConversations.archivedAt),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (rows.length > 0) return "updated";
  const [existing] = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .limit(1);
  if (!existing) return "not_found";
  if (!args.archived && existing.archivedAt === null) return "updated";
  return "conflict";
}

/** Archive or restore one conversation with optimistic activity concurrency control. */
export async function archiveConversation(
  conversationId: string,
  body: ArchiveConversationBody,
): Promise<ArchiveConversationResponse> {
  const result = await archiveIfUnchanged({ ...body, conversationId });
  if (result === "not_found") {
    throwApiError(404, "Conversation not found.");
  }
  if (result === "conflict") {
    throwApiError(409, "Conversation received new activity.");
  }
  return { archived: body.archived };
}
