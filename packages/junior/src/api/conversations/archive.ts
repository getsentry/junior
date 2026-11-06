import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import {
  conversationDetailTouch,
  nextDetailVersion,
} from "@/chat/conversations/sql/detail-version";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { throwApiError } from "../http";
import type {
  ArchiveConversationBody,
  ArchiveConversationResponse,
} from "../schema/conversation-archive";
import { readConversationAccessFromSql } from "./access";

async function setViewerArchive(args: {
  archived: boolean;
  lastSeenAt: string;
  rootConversationId: string;
  userId: string;
}): Promise<
  | { status: "conflict" | "missing" }
  | { archivedAt: string | null; status: "updated" }
> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const [root] = await db
      .select({ lastActivityAt: juniorConversations.lastActivityAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, args.rootConversationId))
      .limit(1)
      .for("update");
    if (!root) return { status: "missing" as const };

    if (args.archived) {
      if (root.lastActivityAt.getTime() !== Date.parse(args.lastSeenAt)) {
        return { status: "conflict" as const };
      }
      const archivedAt = new Date();
      const lastMessageAt = new Date(args.lastSeenAt);
      await db
        .with(conversationDetailTouch(db, [args.rootConversationId]))
        .insert(juniorConversationParticipants)
        .values({
          archivedAt,
          lastMessageAt,
          rootConversationId: args.rootConversationId,
          userId: args.userId,
        })
        .onConflictDoUpdate({
          target: [
            juniorConversationParticipants.userId,
            juniorConversationParticipants.rootConversationId,
          ],
          // Archive also unpins, so the Pinned section holds only active rows.
          set: {
            archivedAt,
            pinnedAt: null,
            pinPosition: null,
            lastMessageAt: sql`greatest(${juniorConversationParticipants.lastMessageAt}, excluded.last_message_at)`,
          },
        });
      return {
        archivedAt: archivedAt.toISOString(),
        status: "updated" as const,
      };
    }

    // A manual restore means the conversation is not done for this user, so
    // auto-archive must not archive it again.
    await db
      .with(conversationDetailTouch(db, [args.rootConversationId]))
      .update(juniorConversationParticipants)
      .set({ archivedAt: null, autoArchive: false })
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
    return { archivedAt: null, status: "updated" as const };
  });
}

/** Archive or restore one Thread for everyone. */
async function setThreadArchive(args: {
  archived: boolean;
  conversationId: string;
  lastSeenAt: string;
}): Promise<
  | { status: "conflict" | "missing" }
  | { archivedAt: string | null; status: "updated" }
> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const [thread] = await db
      .select({ lastActivityAt: juniorConversations.lastActivityAt })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, args.conversationId))
      .limit(1)
      .for("update");
    if (!thread) return { status: "missing" as const };
    if (
      args.archived &&
      thread.lastActivityAt.getTime() !== Date.parse(args.lastSeenAt)
    ) {
      return { status: "conflict" as const };
    }
    const archivedAt = args.archived ? new Date() : null;
    await db
      .update(juniorConversations)
      .set({ detailVersion: nextDetailVersion, threadArchivedAt: archivedAt })
      .where(eq(juniorConversations.conversationId, args.conversationId));
    return {
      archivedAt: archivedAt?.toISOString() ?? null,
      status: "updated" as const,
    };
  });
}

/**
 * Archive or restore one conversation. A Thread archive applies to everyone.
 * A root archive applies only to the signed-in viewer.
 */
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
  const [target] = await getDb()
    .select({
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  if (!target) throwApiError(404, "Conversation not found.");
  const kind = conversationKindFromRow(target);
  // A Task has no archive state of its own. Its root or Thread holds it.
  if (kind === "task") throwApiError(409, "A Task cannot be archived.");
  const result =
    kind === "thread"
      ? await setThreadArchive({
          archived: body.archived,
          conversationId,
          lastSeenAt: body.lastSeenAt,
        })
      : await setViewerArchive({
          archived: body.archived,
          lastSeenAt: body.lastSeenAt,
          rootConversationId: conversationId,
          userId: viewer.id,
        });
  if (result.status === "updated") {
    return { archivedAt: result.archivedAt };
  }
  if (result.status === "missing") {
    throwApiError(404, "Conversation not found.");
  }
  throwApiError(409, "Conversation received new activity.");
}
