import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  conversationAncestors,
  type ConversationTreeNode,
  readConversationTrees,
} from "@/chat/conversations/sql/conversation-tree";
import { juniorConversations } from "@/db/schema";
import type { ConversationFeedItem } from "../schema/conversation-feed";
import type { ConversationAccess } from "./access";
import { readFirstHumanMessageTexts } from "./first-message";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationFromRecordRow, selectConversationRecords } from "./record";

/**
 * Find where a Thread nests: its nearest ancestor that is a listed root or a
 * Thread. A Thread under a Task moves up. Returns undefined when an ancestor
 * is archived, because an archive hides its whole subtree.
 */
function findThreadPlacement(
  threadId: string,
  tree: ReadonlyMap<string, ConversationTreeNode>,
  rootIds: ReadonlySet<string>,
): string | undefined {
  let placement: string | undefined;
  for (const ancestor of conversationAncestors(tree, threadId)) {
    if (rootIds.has(ancestor.conversationId)) {
      return placement ?? ancestor.conversationId;
    }
    if (ancestor.archivedAt) return undefined;
    if (ancestor.kind === "thread") placement ??= ancestor.conversationId;
  }
  return undefined;
}

/**
 * Read the shown Threads of the listed roots for the feed, nested under
 * their nearest shown ancestor. A Thread shows when it and every ancestor
 * have no `archived_at`. The caller passes only unarchived roots, so a root
 * archive hides its tree with no writes to the children. A Thread uses the
 * access of its root.
 */
export async function readFeedThreads(
  db: JuniorDatabase,
  roots: ReadonlyArray<{ access?: ConversationAccess; conversationId: string }>,
): Promise<Map<string, ConversationFeedItem[]>> {
  if (roots.length === 0) return new Map();
  const rootIdList = roots.map((root) => root.conversationId);
  const rootIds = new Set(rootIdList);
  const [rows, tree] = await Promise.all([
    selectConversationRecords(db)
      .where(
        and(
          inArray(juniorConversations.rootConversationId, rootIdList),
          eq(juniorConversations.kind, "thread"),
          isNull(juniorConversations.archivedAt),
        ),
      )
      .orderBy(
        desc(juniorConversations.lastActivityAt),
        asc(juniorConversations.conversationId),
      ),
    readConversationTrees(db, rootIdList),
  ]);
  if (rows.length === 0) return new Map();
  const threads = rows.map((row) => ({
    conversation: conversationFromRecordRow(row),
    row,
  }));
  const accessByRoot = new Map(
    roots.map((root) => [root.conversationId, root.access]),
  );
  const firstHumanMessageTexts = await readFirstHumanMessageTexts(
    db,
    threads.map(({ conversation }) => conversation),
  );
  const childrenByParent = new Map<string, ConversationFeedItem[]>();
  for (const { conversation, row } of threads) {
    const parentId = findThreadPlacement(
      conversation.conversationId,
      tree,
      rootIds,
    );
    if (!parentId) continue;
    const rootId = row.conversation.rootConversationId;
    // Thread usage covers only the Thread. Roots show tree totals.
    const summary = conversationSummaryFromStoredConversation({
      access: rootId ? accessByRoot.get(rootId) : undefined,
      conversation,
      durationMs: row.conversation.durationMs,
      firstHumanMessageText: firstHumanMessageTexts.get(
        conversation.conversationId,
      ),
      ...(row.conversation.usage
        ? { usage: row.conversation.usage }
        : undefined),
    });
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(summary);
    childrenByParent.set(parentId, siblings);
  }
  // Parent edges are set once at create, so placements form a forest.
  const nest = (items: ConversationFeedItem[]): ConversationFeedItem[] =>
    items.map((item) => {
      const children = childrenByParent.get(item.conversationId);
      return children ? { ...item, threads: nest(children) } : item;
    });
  return new Map(
    roots.flatMap((root) => {
      const children = childrenByParent.get(root.conversationId);
      return children ? [[root.conversationId, nest(children)]] : [];
    }),
  );
}
