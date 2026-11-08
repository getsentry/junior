import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import {
  conversationAncestors,
  conversationDescendants,
  readConversationTrees,
  setArchivedAt,
} from "@/chat/conversations/sql/conversation-tree";
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
import { markConversationRead } from "./read-position";

type ArchiveResult =
  | { status: "conflict" | "missing" }
  | { archivedAncestorId: string; status: "archived_ancestor" }
  | { status: "unarchived_children"; unarchivedChildCount: number }
  | { archivedAt: string; status: "archived" }
  | { status: "restored" };

/**
 * Archive or restore one Conversation, root or child, for everyone. Archive
 * refuses while any descendant is unarchived, unless `applyToChildren`
 * archives them too, and when the Conversation has activity after
 * `lastSeenAt`. Restore changes only this Conversation unless
 * `applyToChildren` also restores the descendants archived with it, and it
 * refuses while an ancestor is archived. A restore of a root by `userId`
 * turns off auto-archive for that person.
 */
export async function setConversationArchive(
  args: { applyToChildren: boolean; conversationId: string } & (
    | { archived: true; lastSeenAt: string }
    | { archived: false; userId: string }
  ),
): Promise<ArchiveResult> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    const [target] = await db
      .select({
        lastActivityAt: juniorConversations.lastActivityAt,
        rootConversationId: juniorConversations.rootConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, args.conversationId))
      .limit(1)
      .for("update");
    if (!target) return { status: "missing" as const };
    // A root stores itself as its root. Older rows may leave it null.
    const rootConversationId = target.rootConversationId ?? args.conversationId;
    const tree = await readConversationTrees(db, [rootConversationId]);
    const descendants = conversationDescendants(tree, args.conversationId);
    if (args.archived) {
      if (target.lastActivityAt.getTime() !== Date.parse(args.lastSeenAt)) {
        return { status: "conflict" as const };
      }
      const unarchived = descendants.filter((node) => !node.archivedAt);
      if (unarchived.length > 0 && !args.applyToChildren) {
        return {
          status: "unarchived_children" as const,
          unarchivedChildCount: unarchived.length,
        };
      }
      const archivedAt = new Date();
      // Descendants that are already archived keep their own time.
      await setArchivedAt(
        db,
        [args.conversationId, ...unarchived.map((node) => node.conversationId)],
        archivedAt,
      );
      return {
        archivedAt: archivedAt.toISOString(),
        status: "archived" as const,
      };
    }
    // The topmost archived ancestor is the one to restore first.
    const archivedAncestor = conversationAncestors(tree, args.conversationId)
      .filter((node) => node.archivedAt)
      .at(-1);
    if (archivedAncestor) {
      return {
        archivedAncestorId: archivedAncestor.conversationId,
        status: "archived_ancestor" as const,
      };
    }
    // One archive writes one time to the target and the descendants that it
    // archived. A descendant archived before keeps its own time, so it stays
    // archived, and an undo restores only what the archive wrote.
    const archivedAt = tree.get(args.conversationId)?.archivedAt?.getTime();
    await setArchivedAt(
      db,
      [
        args.conversationId,
        ...(args.applyToChildren && archivedAt !== undefined
          ? descendants
              .filter((node) => node.archivedAt?.getTime() === archivedAt)
              .map((node) => node.conversationId)
          : []),
      ],
      null,
    );
    if (args.conversationId === rootConversationId) {
      // A manual restore means the conversation is not done for this person,
      // so no auto-archive may archive it again, and it subscribes them
      // again (contract: `subscription.ts`). The root actor may not have a
      // participant row yet.
      // oxlint-disable-next-line junior/touch-conversation-detail -- the detail ETag reads the auto-archive choice on each request.
      await db
        .insert(juniorConversationParticipants)
        .values({
          autoArchive: false,
          lastMessageAt: target.lastActivityAt,
          rootConversationId,
          userId: args.userId,
        })
        .onConflictDoUpdate({
          target: [
            juniorConversationParticipants.userId,
            juniorConversationParticipants.rootConversationId,
          ],
          set: { autoArchive: false, unsubscribedAt: null },
        });
    }
    return { status: "restored" as const };
  });
}

/**
 * Archive or restore one Conversation for everyone. Only a participant may
 * do it. The rules are those of `setConversationArchive`.
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
  const applyToChildren = body.applyToChildren ?? false;
  const result = await setConversationArchive(
    body.archived
      ? {
          applyToChildren,
          archived: true,
          conversationId,
          lastSeenAt: body.lastSeenAt,
        }
      : { applyToChildren, archived: false, conversationId, userId: viewer.id },
  );
  switch (result.status) {
    case "archived":
      // Archive also reads the conversation to the end for the person who
      // archived it. The archive saw no newer activity, so the end is what
      // they saw. Other participants keep their read position.
      await markConversationRead(viewer, conversationId, {
        lastReadSeq: Number.MAX_SAFE_INTEGER,
      });
      return { archivedAt: result.archivedAt };
    case "restored":
      return { archivedAt: null };
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
