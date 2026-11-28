import { desc, eq, isNull, or, sql } from "drizzle-orm";
import type { ConversationTreeState } from "@/api/schema/conversation-tree-state";
import { awaitsAuthorizationFrom } from "@/chat/conversations/sql/authorization-wait";
import {
  conversationIsActiveSql,
  conversationWaitsOnUserSql,
  questionWaitsSql,
} from "@/chat/conversations/sql/status";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { listConversationsWithWatches } from "@/chat/events/store";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

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
 * Read the tree state of each Conversation for one viewer, over its whole
 * tree. A waiting question shows to every viewer; a sign-in or start that
 * waits on another person does not. An archived child and its descendants
 * count for nothing, since the feed hides them.
 */
export async function readConversationTreeStates(
  db: JuniorDatabase,
  conversationIds: readonly string[],
  viewerUserId: string | undefined,
): Promise<Map<string, ConversationTreeRead>> {
  if (conversationIds.length === 0) return new Map();
  const scopeId = conversationSubtreeColumns.scopeConversationId;
  const asked = questionWaitsSql(juniorConversations.conversationId);
  const needsViewer = viewerUserId
    ? sql<boolean>`bool_or(${asked} or ${awaitsAuthorizationFrom(
        juniorConversations.conversationId,
        viewerUserId,
      )} or ${conversationWaitsOnUserSql(juniorConversations, viewerUserId)})`
    : sql<boolean>`bool_or(${asked})`;
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
    .where(
      or(
        eq(juniorConversations.conversationId, scopeId),
        isNull(juniorConversations.archivedAt),
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
          ? "needs_input"
          : row.working
            ? "working"
            : "done",
        watching: (row.watchable ?? []).some((id) => watched.has(id)),
      },
    ]),
  );
}
