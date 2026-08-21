import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, sql } from "drizzle-orm";
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

async function readRootActivity(args: {
  lastSeenAt: string;
  rootConversationId: string;
}): Promise<"conflict" | "missing" | "ok"> {
  const [existing] = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      lastActivityAt: juniorConversations.lastActivityAt,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.rootConversationId))
    .limit(1);
  if (!existing) return "missing";
  if (existing.lastActivityAt.getTime() !== Date.parse(args.lastSeenAt)) {
    return "conflict";
  }
  return "ok";
}

async function setViewerArchive(args: {
  archived: boolean;
  lastSeenAt: string;
  rootConversationId: string;
  userId: string;
}): Promise<"conflict" | "missing" | "updated"> {
  const activity = await readRootActivity({
    lastSeenAt: args.lastSeenAt,
    rootConversationId: args.rootConversationId,
  });
  if (activity !== "ok") return activity;

  if (args.archived) {
    const lastMessageAt = new Date(args.lastSeenAt);
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        archivedAt: new Date(),
        lastMessageAt,
        rootConversationId: args.rootConversationId,
        userId: args.userId,
      })
      .onConflictDoUpdate({
        target: [
          juniorConversationParticipants.userId,
          juniorConversationParticipants.rootConversationId,
        ],
        set: {
          archivedAt: new Date(),
          lastMessageAt: sql`greatest(${juniorConversationParticipants.lastMessageAt}, excluded.last_message_at)`,
        },
      });
    return "updated";
  }

  await getDb()
    .update(juniorConversationParticipants)
    .set({ archivedAt: null })
    .where(
      and(
        eq(juniorConversationParticipants.userId, args.userId),
        eq(
          juniorConversationParticipants.rootConversationId,
          args.rootConversationId,
        ),
        isNotNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return "updated";
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
  const result = await setViewerArchive({
    archived: body.archived,
    lastSeenAt: body.lastSeenAt,
    rootConversationId,
    userId: viewer.id,
  });
  if (result === "missing") {
    throwApiError(404, "Conversation not found.");
  }
  if (result === "conflict") {
    throwApiError(409, "Conversation received new activity.");
  }
  return { archived: body.archived };
}
