import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ConversationTreeState } from "@/api/schema/conversation-tree-state";
import { awaitsAuthorizationFrom } from "@/chat/conversations/sql/authorization-wait";
import {
  conversationIsActiveSql,
  conversationWaitsOnUserSql,
} from "@/chat/conversations/sql/status";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { listConversationsWithWatches } from "@/chat/events/store";
import {
  reviewItemForUser,
  reviewItemNeedsInput,
} from "@/chat/review-items/access";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorReviewItems } from "@/db/schema";

/**
 * The most Conversations of one tree whose Watches a read checks, newest
 * activity first. A tree with more children than this can miss a Watch on
 * an old child.
 */
const WATCH_LOOKUP_LIMIT = 50;

/** The tree state of one Conversation, and whether its tree watches. */
export type ConversationTreeRead = {
  treeState: ConversationTreeState;
  watching: boolean;
};

/**
 * SQL: the Conversation needs input from this User. An open action Review
 * item that it added is assigned to the User, to Everyone, or to no one, or
 * a Turn waits on the User to sign in.
 */
function needsUserSql(userId: string) {
  return sql<boolean>`(exists (select 1 from ${juniorReviewItems} where ${and(
    eq(
      juniorReviewItems.addedByConversationId,
      juniorConversations.conversationId,
    ),
    reviewItemNeedsInput(),
    reviewItemForUser(userId),
  )}) or ${awaitsAuthorizationFrom(juniorConversations.conversationId, userId)})`;
}

/**
 * Read the tree state of each Conversation for one viewer, over the
 * Conversation and every child Conversation at any depth. When more than
 * one applies:
 *
 * - `needs_you`: the tree's `needs_input` includes the viewer. A Review
 *   item or a sign-in wait anywhere in the tree counts. Only the
 *   Conversation's own wait on its starter counts, and only when the
 *   viewer is the starter. Input that waits on another person is not
 *   shown.
 * - `working`: a Turn is queued or running anywhere in the tree.
 * - `done`: anything else.
 *
 * `watching` is set when a Conversation in the tree that is not stopped has
 * an active Watch or a pending Timer. It is not part of the shared status.
 *
 * Children use the visibility of their root, so a viewer who can see the
 * row may see its tree state. It shows no child's content.
 *
 * One SQL statement reads the trees, then two batched state reads check
 * Watches and Timers.
 */
export async function readConversationTreeStates(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  viewerUserId: string | undefined,
): Promise<Map<string, ConversationTreeRead>> {
  if (conversationIds.length === 0) return new Map();
  const scopeId = conversationSubtreeColumns.scopeConversationId;
  const needsViewer = viewerUserId
    ? sql<boolean>`bool_or(${needsUserSql(viewerUserId)} or (${eq(
        juniorConversations.conversationId,
        scopeId,
      )} and ${conversationWaitsOnUserSql(juniorConversations, viewerUserId)}))`
    : sql<boolean>`false`;
  const rows = await db
    .select({
      conversationId: scopeId,
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
    .groupBy(scopeId);
  const watched = await listConversationsWithWatches({
    conversationIds: [...new Set(rows.flatMap((row) => row.watchable ?? []))],
  });
  return new Map(
    rows.map((row) => [
      row.conversationId,
      {
        treeState: row.needsViewer
          ? "needs_you"
          : row.working
            ? "working"
            : "done",
        watching: (row.watchable ?? []).some((id) => watched.has(id)),
      },
    ]),
  );
}
