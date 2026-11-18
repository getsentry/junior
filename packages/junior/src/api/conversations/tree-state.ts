import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ConversationTreeState } from "@/api/schema/conversation";
import { conversationIsActiveSql } from "@/chat/conversations/sql/status";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { listConversationsWithWatches } from "@/chat/events/store";
import { reviewItemNeedsUser } from "@/chat/review-items/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorReviewItems } from "@/db/schema";

/**
 * The most Conversations of one tree whose Watches a read checks, newest
 * activity first. A tree with more children than this can miss a Watch on
 * an old child, and then shows no state.
 */
const WATCH_LOOKUP_LIMIT = 50;

/**
 * Read the tree state of each Conversation for one viewer: the Conversation
 * and every child Conversation at any depth. When more than one applies:
 *
 * - `needs_you`: an open action Review item, added anywhere in the tree,
 *   waits on the viewer (`reviewItemNeedsUser`).
 * - `working`: a Conversation in the tree is `active`. Pending Agent
 *   invocations and agent dispatches run as their child's execution, so
 *   they count here.
 * - `waiting`: a Conversation in the tree that is not stopped has an active
 *   Watch or Timer.
 *
 * Children use the visibility of their root, so a viewer who can see the
 * row may see its tree state. It shows no child's content.
 *
 * One SQL statement reads the trees, then two batched state reads check
 * Watches for the trees with no other state. A Conversation with no state
 * has no entry.
 */
export async function readConversationTreeStates(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  viewerUserId: string | undefined,
): Promise<Map<string, ConversationTreeState>> {
  if (conversationIds.length === 0) return new Map();
  const needsViewer = viewerUserId
    ? sql<boolean>`bool_or(exists (select 1 from ${juniorReviewItems} where ${and(
        eq(
          juniorReviewItems.addedByConversationId,
          juniorConversations.conversationId,
        ),
        reviewItemNeedsUser(viewerUserId),
      )}))`
    : sql<boolean>`false`;
  const rows = await db
    .select({
      conversationId: conversationSubtreeColumns.scopeConversationId,
      needsViewer,
      working: sql<boolean>`bool_or(${conversationIsActiveSql(juniorConversations)})`,
      // A stopped Conversation saves its Watch Events and starts no Turn.
      watchable: sql<string[] | null>`(array_agg(${
        juniorConversations.conversationId
      } order by ${desc(juniorConversations.lastActivityAt)}) filter (where ${isNull(
        juniorConversations.stoppedAt,
      )}))[1:${WATCH_LOOKUP_LIMIT}]`,
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree(conversationIds),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .groupBy(conversationSubtreeColumns.scopeConversationId);
  const states = new Map<string, ConversationTreeState>();
  const unresolved: typeof rows = [];
  for (const row of rows) {
    if (row.needsViewer) states.set(row.conversationId, "needs_you");
    else if (row.working) states.set(row.conversationId, "working");
    else if (row.watchable?.length) unresolved.push(row);
  }
  const watched = await listConversationsWithWatches({
    conversationIds: [...new Set(unresolved.flatMap((row) => row.watchable!))],
  });
  for (const row of unresolved) {
    if (row.watchable!.some((id) => watched.has(id))) {
      states.set(row.conversationId, "waiting");
    }
  }
  return states;
}
