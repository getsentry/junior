import { eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { getChildAgentLabel } from "@/chat/agent-invocations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { ConversationAgentTreeNode } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";
import { conversationSummaryFromStoredConversation } from "./projection";

/** Bound the parent chain that one agent tree reads. */
const MAX_AGENT_TREE_DEPTH = 16;
const CHILD_LABEL = "Subagent";

async function readParentConversationId(
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ parentId: juniorConversations.parentConversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return row?.parentId ?? undefined;
}

/**
 * Read the agent tree of a child Conversation: its parent chain, root first,
 * with the child last. Returns undefined for a root Conversation. Each
 * Conversation has its own access check, so a viewer sees a label only where
 * they can see private content.
 */
export async function readConversationAgentTree(
  conversationId: string,
  viewer?: User,
): Promise<ConversationAgentTreeNode[] | undefined> {
  // Read only parent ids. Every detail request calls this, and a root
  // Conversation must not need a full Conversation record.
  const ids = [conversationId];
  let parentId = await readParentConversationId(conversationId);
  while (
    parentId &&
    !ids.includes(parentId) &&
    ids.length < MAX_AGENT_TREE_DEPTH
  ) {
    ids.unshift(parentId);
    parentId = await readParentConversationId(parentId);
  }
  if (ids.length < 2) {
    return undefined;
  }
  // After a cycle or the depth bound, the first id is still a child.
  const root = parentId
    ? undefined
    : await getConversationStore().get({ conversationId: ids[0]! });

  const access = await readConversationAccessFromSql(getDb(), ids, viewer);
  return await Promise.all(
    ids.map(async (id) => {
      const itemAccess = access.get(id);
      if (root?.conversationId === id) {
        // The summary projection owns root titles and their privacy labels.
        const summary = conversationSummaryFromStoredConversation({
          access: itemAccess,
          conversation: root,
          durationMs: 0,
        });
        return { conversationId: id, label: summary.displayTitle };
      }
      if (!itemAccess?.canViewPrivateContent) {
        return { conversationId: id, label: CHILD_LABEL };
      }
      const agent = await getChildAgentLabel(id);
      return {
        conversationId: id,
        label: agent?.title ?? agent?.agentName ?? CHILD_LABEL,
      };
    }),
  );
}
