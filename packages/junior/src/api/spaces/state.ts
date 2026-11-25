import { and, desc, inArray, isNull } from "drizzle-orm";
import { conversationTurnFailedSql } from "@/chat/conversations/sql/status";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { readConversationTreeStates } from "../conversations/tree-state";
import { rootVisibleToViewer } from "../conversations/membership";
import type { ConversationTreeState } from "../schema/conversation-tree-state";

/**
 * The most Conversations of the listed Spaces that one read rolls up, newest
 * activity first. The Lead archives finished work, so a Space has few
 * Conversations that are not archived. Past this, the oldest ones count for
 * nothing.
 */
const SPACE_STATE_CONVERSATION_LIMIT = 200;

/** What a Space's Conversations need, for one viewer. */
export type SpaceStateRead = {
  latestTurnFailed: boolean;
  treeState: ConversationTreeState;
};

const TREE_STATE_ORDER: readonly ConversationTreeState[] = [
  "needs_you",
  "working",
  "done",
];

/**
 * Roll up the tree state of every Conversation in each Space that the viewer
 * can read and that is not archived, the Lead included. Each Space gets an
 * entry, and a Space with none of them reads `done`. `treeState` is the
 * first that applies over them, as for one Conversation. `latestTurnFailed`
 * is set when the latest Turn of one of them failed.
 */
export async function readSpaceStates(
  db: JuniorDatabase,
  spaceIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, SpaceStateRead>> {
  if (spaceIds.length === 0) return new Map();
  const roots = await db
    .select({
      conversationId: juniorConversations.conversationId,
      spaceId: juniorConversations.spaceId,
      latestTurnFailed: conversationTurnFailedSql(juniorConversations),
    })
    .from(juniorConversations)
    .where(
      and(
        inArray(juniorConversations.spaceId, [...spaceIds]),
        isNull(juniorConversations.parentConversationId),
        isNull(juniorConversations.archivedAt),
        isNull(juniorConversations.quickQuestionAt),
        rootVisibleToViewer(viewerUserId),
      ),
    )
    .orderBy(desc(juniorConversations.lastActivityAt))
    .limit(SPACE_STATE_CONVERSATION_LIMIT);
  const trees = await readConversationTreeStates(
    db,
    roots.map((root) => root.conversationId),
    viewerUserId,
  );
  const states = new Map<string, SpaceStateRead>(
    spaceIds.map((spaceId) => [
      spaceId,
      { latestTurnFailed: false, treeState: "done" },
    ]),
  );
  for (const root of roots) {
    const current = root.spaceId ? states.get(root.spaceId) : undefined;
    if (!current) continue;
    const treeState = trees.get(root.conversationId)?.treeState ?? "done";
    if (root.latestTurnFailed) current.latestTurnFailed = true;
    if (
      TREE_STATE_ORDER.indexOf(treeState) <
      TREE_STATE_ORDER.indexOf(current.treeState)
    ) {
      current.treeState = treeState;
    }
  }
  return states;
}
