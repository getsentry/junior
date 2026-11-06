import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { juniorConversations } from "@/db/schema";
import type { ConversationFeedItem } from "../schema/conversation";
import type { ConversationAccess } from "./access";
import { readFirstHumanMessageTexts } from "./first-message";
import { conversationSummaryFromStoredConversation } from "./projection";
import { conversationFromRecordRow, selectConversationRecords } from "./record";

type TreeEdge = { parentConversationId?: string; shownThread: boolean };

/**
 * Read the parent edge of every descendant of the listed roots. Every
 * descendant shares `root_conversation_id`, so one indexed read covers trees
 * of any depth.
 */
async function readTreeEdges(
  db: JuniorDatabase,
  rootIds: readonly string[],
): Promise<Map<string, TreeEdge>> {
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      threadArchivedAt: juniorConversations.threadArchivedAt,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.rootConversationId, [...rootIds]));
  return new Map(
    rows.map((row) => [
      row.conversationId,
      {
        ...(row.parentConversationId
          ? { parentConversationId: row.parentConversationId }
          : undefined),
        shownThread:
          conversationKindFromRow(row) === "thread" && !row.threadArchivedAt,
      },
    ]),
  );
}

/**
 * Find where a Thread nests: its nearest ancestor that is a listed root or a
 * shown Thread. A Thread under a Task or an archived Thread moves up. Returns
 * undefined when no shown ancestor exists.
 */
function findThreadPlacement(
  threadId: string,
  edges: ReadonlyMap<string, TreeEdge>,
  rootIds: ReadonlySet<string>,
): string | undefined {
  const seen = new Set([threadId]);
  let ancestorId = edges.get(threadId)?.parentConversationId;
  while (ancestorId && !seen.has(ancestorId)) {
    const edge = edges.get(ancestorId);
    if (rootIds.has(ancestorId) || edge?.shownThread) return ancestorId;
    seen.add(ancestorId);
    ancestorId = edge?.parentConversationId;
  }
  return undefined;
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
  const rootIdList = roots.map((root) => root.conversationId);
  const rootIds = new Set(rootIdList);
  const [rows, edges] = await Promise.all([
    selectConversationRecords(db)
      .where(
        and(
          inArray(juniorConversations.rootConversationId, rootIdList),
          eq(juniorConversations.kind, "thread"),
          isNull(juniorConversations.threadArchivedAt),
        ),
      )
      .orderBy(
        desc(juniorConversations.lastActivityAt),
        asc(juniorConversations.conversationId),
      ),
    readTreeEdges(db, rootIdList),
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
      edges,
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
