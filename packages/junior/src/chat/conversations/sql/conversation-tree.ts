import { and, eq, inArray, SQL } from "drizzle-orm";
import type { ConversationKind } from "@/chat/conversations/store";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { conversationKindFromRow } from "./conversation-row";
import { nextDetailVersion } from "./detail-version";

/** One Conversation in a tree, with the fields that archive rules read. */
export type ConversationTreeNode = {
  archivedAt: Date | null;
  conversationId: string;
  kind: ConversationKind;
  parentConversationId?: string;
  rootConversationId?: string;
};

/**
 * Read every Conversation in the work of the given top-level Conversations.
 * Each one shares `top_level_conversation_id`, so one indexed read covers any
 * depth.
 */
export async function readConversationTrees(
  db: JuniorDatabase,
  rootConversationIds: readonly string[],
): Promise<Map<string, ConversationTreeNode>> {
  if (rootConversationIds.length === 0) return new Map();
  const rows = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      rootConversationId: juniorConversations.topLevelConversationId,
    })
    .from(juniorConversations)
    .where(
      inArray(juniorConversations.topLevelConversationId, [
        ...rootConversationIds,
      ]),
    );
  return new Map(
    rows.map((row) => [
      row.conversationId,
      {
        archivedAt: row.archivedAt,
        conversationId: row.conversationId,
        kind: conversationKindFromRow(row),
        ...(row.parentConversationId
          ? { parentConversationId: row.parentConversationId }
          : undefined),
        ...(row.rootConversationId
          ? { rootConversationId: row.rootConversationId }
          : undefined),
      },
    ]),
  );
}

/** List the ancestors of one Conversation, nearest first, root last. */
export function conversationAncestors(
  tree: ReadonlyMap<string, ConversationTreeNode>,
  conversationId: string,
): ConversationTreeNode[] {
  const ancestors: ConversationTreeNode[] = [];
  const seen = new Set([conversationId]);
  let parentId = tree.get(conversationId)?.parentConversationId;
  while (parentId && !seen.has(parentId)) {
    const parent = tree.get(parentId);
    if (!parent) break;
    ancestors.push(parent);
    seen.add(parentId);
    parentId = parent.parentConversationId;
  }
  return ancestors;
}

/** List every descendant of one Conversation, at any depth. */
export function conversationDescendants(
  tree: ReadonlyMap<string, ConversationTreeNode>,
  conversationId: string,
): ConversationTreeNode[] {
  const childrenByParent = new Map<string, ConversationTreeNode[]>();
  for (const node of tree.values()) {
    if (!node.parentConversationId) continue;
    const siblings = childrenByParent.get(node.parentConversationId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentConversationId, siblings);
  }
  const descendants: ConversationTreeNode[] = [];
  const seen = new Set([conversationId]);
  const pending = [conversationId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const child of childrenByParent.get(id) ?? []) {
      if (seen.has(child.conversationId)) continue;
      seen.add(child.conversationId);
      descendants.push(child);
      pending.push(child.conversationId);
    }
  }
  return descendants;
}

/**
 * Set or clear the shared archive and count the rows written. This is the
 * only write of `archived_at`. `conversations` names the rows by id or by a
 * condition. `guard` is a condition that each row must still meet when it is
 * written, so a stale read loses to a newer change.
 */
export async function setArchivedAt(
  db: JuniorDatabase,
  conversations: readonly string[] | SQL,
  archivedAt: Date | null,
  guard?: SQL,
): Promise<number> {
  if (!(conversations instanceof SQL) && conversations.length === 0) return 0;
  const updated = await db
    .update(juniorConversations)
    .set({ archivedAt, detailVersion: nextDetailVersion })
    .where(
      and(
        conversations instanceof SQL
          ? conversations
          : inArray(juniorConversations.conversationId, [...conversations]),
        guard,
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  return updated.length;
}

/**
 * Restore one archived Conversation and its archived ancestors, so it shows
 * again. Its descendants keep their archive.
 */
export async function restoreArchivedPath(
  db: JuniorDatabase,
  conversationId: string,
): Promise<void> {
  const [row] = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      parentConversationId: juniorConversations.parentConversationId,
      rootConversationId: juniorConversations.topLevelConversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  if (!row) return;
  // Most messages land in a root, so skip the tree read there.
  if (!row.parentConversationId || !row.rootConversationId) {
    if (row.archivedAt) await setArchivedAt(db, [conversationId], null);
    return;
  }
  const tree = await readConversationTrees(db, [row.rootConversationId]);
  const node = tree.get(conversationId);
  if (!node) return;
  await setArchivedAt(
    db,
    [node, ...conversationAncestors(tree, conversationId)]
      .filter((entry) => entry.archivedAt)
      .map((entry) => entry.conversationId),
    null,
  );
}
