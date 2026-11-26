import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
} from "drizzle-orm";
import { topLevelConversation } from "@/chat/conversations/sql/listed";
import { isThread } from "@/chat/conversations/kind-behavior";
import type { JuniorDatabase } from "@/db/db";
import {
  conversationAncestors,
  type ConversationTreeNode,
} from "@/chat/conversations/sql/conversation-tree";
import { juniorConversations } from "@/db/schema";
import {
  CONVERSATION_FEED_THREAD_LIMIT,
  type ConversationFeedItem,
} from "../schema/conversation-feed";
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
    if (isThread(ancestor)) placement ??= ancestor.conversationId;
  }
  return undefined;
}

/** The stored Threads of the listed roots, before access applies. */
type FeedThreadRecords = Awaited<ReturnType<typeof readFeedThreadRecords>>;

/**
 * Read the stored Threads of the listed roots for the feed, with their
 * read-time titles. It needs no access, so it can start with the other
 * feed reads. The caller passes only unarchived roots, so a root archive
 * hides its tree with no writes to the children.
 */
export async function readFeedThreadRecords(
  db: JuniorDatabase,
  rootIds: string[],
) {
  if (rootIds.length === 0) return undefined;
  const rows = await selectConversationRecords(db)
    .where(
      and(
        inArray(juniorConversations.rootConversationId, rootIds),
        // A child Thread: a `thread` with a parent, other than a Lead's
        // child, which is top-level Space work.
        eq(juniorConversations.kind, "thread"),
        isNotNull(juniorConversations.parentConversationId),
        not(topLevelConversation()),
        isNull(juniorConversations.archivedAt),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    );
  if (rows.length === 0) return undefined;
  const threads = rows.map((row) => ({
    conversation: conversationFromRecordRow(row),
    row,
  }));
  const firstHumanMessageTexts = await readFirstHumanMessageTexts(
    db,
    threads.map(({ conversation }) => conversation),
  );
  return { firstHumanMessageTexts, rootIds: new Set(rootIds), threads };
}

/** The Threads that a feed row lists, and how many the cap left out. */
type FeedRowThreads = {
  omittedThreadCount: number;
  threads: ConversationFeedItem[];
};

/**
 * Nest the shown Threads of `readFeedThreadRecords` under their nearest shown
 * ancestor. A Thread shows when it and every ancestor have no
 * `archived_at`. A Thread uses the access of its root. `tree` holds the
 * trees of at least the listed roots. Each root lists at most
 * `CONVERSATION_FEED_THREAD_LIMIT` Threads, depth first in activity order,
 * so a kept Thread always has its parent.
 */
export function nestFeedThreads(
  records: FeedThreadRecords,
  tree: ReadonlyMap<string, ConversationTreeNode>,
  accessByRoot: ReadonlyMap<string, ConversationAccess | undefined>,
): Map<string, FeedRowThreads> {
  if (!records) return new Map();
  const { firstHumanMessageTexts, rootIds, threads } = records;
  const childrenByParent = new Map<string, ConversationFeedItem[]>();
  const placedByRoot = new Map<string, number>();
  for (const { conversation, row } of threads) {
    const parentId = findThreadPlacement(
      conversation.conversationId,
      tree,
      rootIds,
    );
    if (!parentId) continue;
    const rootId = row.conversation.rootConversationId;
    if (rootId) placedByRoot.set(rootId, (placedByRoot.get(rootId) ?? 0) + 1);
    // Thread usage covers only the Thread. Roots show tree totals.
    const summary = conversationSummaryFromStoredConversation({
      access: rootId ? accessByRoot.get(rootId) : undefined,
      conversation,
      durationMs: row.conversation.durationMs,
      firstHumanMessageText: firstHumanMessageTexts.get(
        conversation.conversationId,
      ),
      status: row.status,
      ...(row.conversation.usage
        ? { usage: row.conversation.usage }
        : undefined),
    });
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(summary);
    childrenByParent.set(parentId, siblings);
  }
  // Parent edges are set once at create, so placements form a forest.
  const nest = (
    items: ConversationFeedItem[],
    budget: { left: number },
  ): ConversationFeedItem[] =>
    items.flatMap((item) => {
      if (budget.left === 0) return [];
      budget.left -= 1;
      const children = childrenByParent.get(item.conversationId);
      const nested = children ? nest(children, budget) : [];
      return [nested.length > 0 ? { ...item, threads: nested } : item];
    });
  return new Map(
    [...rootIds].flatMap((rootId) => {
      const children = childrenByParent.get(rootId);
      if (!children) return [];
      const budget = { left: CONVERSATION_FEED_THREAD_LIMIT };
      const nested = nest(children, budget);
      const shown = CONVERSATION_FEED_THREAD_LIMIT - budget.left;
      return [
        [
          rootId,
          {
            omittedThreadCount: (placedByRoot.get(rootId) ?? 0) - shown,
            threads: nested,
          },
        ],
      ];
    }),
  );
}
