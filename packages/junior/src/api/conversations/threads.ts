import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import type { ConversationFeedItem } from "../schema/conversation";
import type { ConversationAccess } from "./access";
import { readFirstHumanMessageTexts } from "./first-message";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationFromRecordRow, selectConversationRecords } from "./record";

/** Bound the walk from a Thread up to its nearest shown ancestor. */
const MAX_THREAD_ANCESTOR_DEPTH = 16;

/**
 * Find where each Thread nests: its nearest ancestor that is the root or a
 * shown Thread. A Thread under a Task or an archived Thread moves up.
 * Returns no entry for a Thread with no shown ancestor in reach.
 */
async function readThreadPlacements(
  db: JuniorDatabase,
  threads: ReadonlyArray<{
    conversationId: string;
    parentConversationId?: string;
  }>,
  shownIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const parentById = new Map<string, string | undefined>(
    threads.map((thread) => [
      thread.conversationId,
      thread.parentConversationId,
    ]),
  );
  const placements = new Map<string, string>();
  let pending = threads.map((thread) => ({
    ancestorId: thread.parentConversationId,
    threadId: thread.conversationId,
  }));
  for (let depth = 0; depth < MAX_THREAD_ANCESTOR_DEPTH; depth += 1) {
    const unknown = new Set<string>();
    const next: typeof pending = [];
    for (const item of pending) {
      if (!item.ancestorId) continue;
      if (shownIds.has(item.ancestorId)) {
        placements.set(item.threadId, item.ancestorId);
        continue;
      }
      if (parentById.has(item.ancestorId)) {
        next.push({
          ancestorId: parentById.get(item.ancestorId),
          threadId: item.threadId,
        });
        continue;
      }
      unknown.add(item.ancestorId);
      next.push(item);
    }
    if (next.length === 0) break;
    if (unknown.size > 0) {
      const rows = await db
        .select({
          conversationId: juniorConversations.conversationId,
          parentConversationId: juniorConversations.parentConversationId,
        })
        .from(juniorConversations)
        .where(inArray(juniorConversations.conversationId, [...unknown]));
      for (const id of unknown) parentById.set(id, undefined);
      for (const row of rows) {
        parentById.set(
          row.conversationId,
          row.parentConversationId ?? undefined,
        );
      }
    }
    pending = next;
  }
  return placements;
}

/**
 * Read the shown Threads of the listed roots for the feed, nested under
 * their nearest shown ancestor. A Thread shows when `thread_archived_at` is
 * null. The caller passes only roots that the viewer has not archived, so a
 * root archive hides its tree with no writes to the Threads. A Thread uses
 * the access of its root.
 */
export async function readFeedThreads(
  db: JuniorDatabase,
  roots: ReadonlyArray<{ access?: ConversationAccess; conversationId: string }>,
): Promise<Map<string, ConversationFeedItem[]>> {
  if (roots.length === 0) return new Map();
  const rows = await selectConversationRecords(db)
    .where(
      and(
        inArray(
          juniorConversations.rootConversationId,
          roots.map((root) => root.conversationId),
        ),
        eq(juniorConversations.kind, "thread"),
        isNull(juniorConversations.threadArchivedAt),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    );
  if (rows.length === 0) return new Map();
  const threads = rows.map((row) => ({
    conversation: conversationFromRecordRow(row),
    row,
  }));
  const accessByRoot = new Map(
    roots.map((root) => [root.conversationId, root.access]),
  );
  const shownIds = new Set([
    ...roots.map((root) => root.conversationId),
    ...threads.map(({ conversation }) => conversation.conversationId),
  ]);
  const [placements, firstHumanMessageTexts] = await Promise.all([
    readThreadPlacements(
      db,
      threads.map(({ conversation }) => conversation),
      shownIds,
    ),
    readFirstHumanMessageTexts(
      db,
      threads.map(({ conversation }) => conversation),
    ),
  ]);
  const childrenByParent = new Map<string, ConversationFeedItem[]>();
  for (const { conversation, row } of threads) {
    const parentId = placements.get(conversation.conversationId);
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
