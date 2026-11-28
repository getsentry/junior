import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conversationTurnFailedSql } from "@/chat/conversations/sql/status";
import { rootSpaceIdSql } from "@/chat/spaces/tree-space";
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

const spaceLead = alias(juniorConversations, "state_space_lead");

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
  // The Space's top-level Conversations are its Lead and the Lead's direct
  // children. `junior_conversations_space_lead_idx` finds the Leads, and the
  // primary key and `junior_conversations_parent_idx` find the rows, only
  // with `= any(array(...))`: an `or` of two `in` subqueries reads the table.
  // The tree state of each one covers its own child agents.
  const leads = sql`array(${db
    .select({ id: spaceLead.conversationId })
    .from(spaceLead)
    .where(
      and(
        eq(spaceLead.kind, "lead"),
        inArray(spaceLead.spaceId, [...spaceIds]),
      ),
    )})`;
  const roots = await db
    .select({
      conversationId: juniorConversations.conversationId,
      spaceId: rootSpaceIdSql(juniorConversations),
      latestTurnFailed: conversationTurnFailedSql(juniorConversations),
    })
    .from(juniorConversations)
    .where(
      and(
        or(
          sql`${juniorConversations.conversationId} = any(${leads})`,
          sql`${juniorConversations.parentConversationId} = any(${leads})`,
        ),
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
