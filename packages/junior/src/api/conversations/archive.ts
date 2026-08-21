import type { User } from "@sentry/junior-plugin-api";
import { and, eq, exists, isNotNull } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ArchiveConversationBody,
  ArchiveConversationResponse,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

async function archiveIfUnchanged(args: {
  archived: boolean;
  lastSeenAt: string;
  rootConversationId: string;
  userId: string;
}): Promise<"conflict" | "updated"> {
  const db = getDb();
  const currentConversation = db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, args.rootConversationId),
        eq(juniorConversations.lastActivityAt, new Date(args.lastSeenAt)),
      ),
    );
  const rows = await db
    .update(juniorConversationParticipants)
    .set({ archivedAt: args.archived ? new Date() : null })
    .where(
      and(
        eq(juniorConversationParticipants.userId, args.userId),
        eq(
          juniorConversationParticipants.rootConversationId,
          args.rootConversationId,
        ),
        args.archived ? exists(currentConversation) : undefined,
        args.archived
          ? undefined
          : isNotNull(juniorConversationParticipants.archivedAt),
      ),
    )
    .returning({ userId: juniorConversationParticipants.userId });
  if (rows.length > 0 || !args.archived) return "updated";
  return "conflict";
}

/** Read one viewer's archive timestamp for a conversation root. */
export async function readConversationArchivedAt(
  viewer: User,
  conversationId: string,
): Promise<number | undefined> {
  const rootConversationId = await resolveRootConversationId(
    getSqlExecutor(),
    conversationId,
  );
  const [row] = await getDb()
    .select({ archivedAt: juniorConversationParticipants.archivedAt })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(juniorConversationParticipants.userId, viewer.id),
        eq(
          juniorConversationParticipants.rootConversationId,
          rootConversationId,
        ),
      ),
    )
    .limit(1);
  return row?.archivedAt?.getTime();
}

/** Archive or restore one conversation for the signed-in viewer. */
export async function archiveConversation(
  viewer: User,
  conversationId: string,
  body: ArchiveConversationBody,
): Promise<ArchiveConversationResponse> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const rootConversationId = await resolveRootConversationId(
    getSqlExecutor(),
    conversationId,
  );
  const result = await archiveIfUnchanged({
    archived: body.archived,
    lastSeenAt: body.lastSeenAt,
    rootConversationId,
    userId: viewer.id,
  });
  if (result === "conflict") {
    throwApiError(409, "Conversation received new activity.");
  }
  return { archived: body.archived };
}
