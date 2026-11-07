import type { User } from "@sentry/junior-plugin-api";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import {
  conversationAncestors,
  conversationDescendants,
  readConversationTrees,
  setChildArchivedAt,
} from "@/chat/conversations/sql/conversation-tree";
import { conversationDetailTouch } from "@/chat/conversations/sql/detail-version";
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

type ChildArchiveResult =
  | { status: "conflict" | "missing" }
  | { archivedAncestorId: string; status: "archived_ancestor" }
  | { status: "unarchived_children"; unarchivedChildCount: number }
  | { archivedAt: string | null; status: "updated" };

/**
 * Archive or restore one child for everyone. Archive refuses while any
 * descendant is unarchived, unless `applyToChildren` archives them too.
 * Restore changes only this child unless `applyToChildren` also restores its
 * descendants, and it refuses while an ancestor child is archived.
 */
async function setChildArchive(args: {
  applyToChildren: boolean;
  archived: boolean;
  conversationId: string;
  lastSeenAt: string;
}): Promise<ChildArchiveResult> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const [child] = await db
      .select({
        lastActivityAt: juniorConversations.lastActivityAt,
        rootConversationId: juniorConversations.rootConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, args.conversationId))
      .limit(1)
      .for("update");
    if (!child?.rootConversationId) return { status: "missing" as const };
    if (
      args.archived &&
      child.lastActivityAt.getTime() !== Date.parse(args.lastSeenAt)
    ) {
      return { status: "conflict" as const };
    }
    const tree = await readConversationTrees(db, [child.rootConversationId]);
    const descendants = conversationDescendants(tree, args.conversationId);
    if (args.archived) {
      const unarchived = descendants.filter((node) => !node.childArchivedAt);
      if (unarchived.length > 0 && !args.applyToChildren) {
        return {
          status: "unarchived_children" as const,
          unarchivedChildCount: unarchived.length,
        };
      }
      const archivedAt = new Date();
      // Descendants that are already archived keep their own time.
      await setChildArchivedAt(
        db,
        [args.conversationId, ...unarchived.map((node) => node.conversationId)],
        archivedAt,
      );
      return {
        archivedAt: archivedAt.toISOString(),
        status: "updated" as const,
      };
    }
    // The topmost archived ancestor child is the one to restore first.
    const archivedAncestor = conversationAncestors(tree, args.conversationId)
      .filter((node) => node.kind !== "root" && node.childArchivedAt)
      .at(-1);
    if (archivedAncestor) {
      return {
        archivedAncestorId: archivedAncestor.conversationId,
        status: "archived_ancestor" as const,
      };
    }
    await setChildArchivedAt(
      db,
      [
        args.conversationId,
        ...(args.applyToChildren
          ? descendants
              .filter((node) => node.childArchivedAt)
              .map((node) => node.conversationId)
          : []),
      ],
      null,
    );
    return { archivedAt: null, status: "updated" as const };
  });
}

/**
 * Archive or restore one conversation. A root archive applies only to the
 * signed-in viewer and hides its whole tree for that viewer, so it writes no
 * child rows and ignores `applyToChildren`. A child archive, Thread or Task,
 * applies to everyone and follows the rules of `setChildArchive`.
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
  const result =
    conversationKindFromRow(target) === "root"
      ? await setViewerArchive({
          archived: body.archived,
          lastSeenAt: body.lastSeenAt,
          rootConversationId: conversationId,
          userId: viewer.id,
        })
      : await setChildArchive({
          applyToChildren: body.applyToChildren ?? false,
          archived: body.archived,
          conversationId,
          lastSeenAt: body.lastSeenAt,
        });
  switch (result.status) {
    case "updated":
      return { archivedAt: result.archivedAt };
    case "missing":
      throwApiError(404, "Conversation not found.");
    case "conflict":
      throwApiError(409, "Conversation received new activity.");
    case "unarchived_children":
      throwApiError(
        409,
        result.unarchivedChildCount === 1
          ? "1 child conversation is not archived. Pass applyToChildren to archive it too."
          : `${result.unarchivedChildCount} child conversations are not archived. Pass applyToChildren to archive them too.`,
      );
    case "archived_ancestor":
      throwApiError(
        409,
        `Conversation ${result.archivedAncestorId} above this one is archived. Restore it first.`,
      );
  }
}
