import { getChildAgentLabel } from "@/chat/agent-invocations/store";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { readConversationLineage } from "@/chat/conversations/lineage";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationAgentTreeNode } from "../schema/conversation";
import type { ConversationAccessReader } from "./access";
import { readFirstHumanMessageTexts } from "./first-message";
import { conversationSummaryFromStoredConversation } from "./projection";

/** Bound the parent chain that one agent tree reads. */
const MAX_AGENT_TREE_DEPTH = 16;
const CHILD_LABEL = "Subagent";

/**
 * Read the agent tree of a child Conversation: its parent chain, root first,
 * with the child last. Returns undefined for a root Conversation. Each
 * Conversation has its own access check, so a viewer sees a label only where
 * they can see private content.
 */
export async function readConversationAgentTree(
  conversationId: string,
  readAccess: ConversationAccessReader,
): Promise<ConversationAgentTreeNode[] | undefined> {
  // Every detail request calls this, and a root Conversation must not need a
  // full Conversation record.
  const lineage = (await readConversationLineage(conversationId)).slice(
    -MAX_AGENT_TREE_DEPTH,
  );
  if (lineage.length < 2) {
    return undefined;
  }
  const ids = lineage.map((entry) => entry.conversationId);
  // After a cycle or the depth bound, the first entry is still a child.
  const root = lineage[0]!.parentConversationId
    ? undefined
    : await getConversationStore().get({ conversationId: ids[0]! });

  const [
    access,
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
  ] = await Promise.all([
    readAccess(ids),
    readAutomationTitlesByConversationId(root ? [root] : []),
    readFirstHumanMessageTexts(getDb(), root ? [root] : []),
  ]);
  return await Promise.all(
    ids.map(async (id) => {
      const itemAccess = access.get(id);
      if (root?.conversationId === id) {
        // The summary projection owns root titles and their privacy labels.
        const summary = conversationSummaryFromStoredConversation({
          access: itemAccess,
          automationTitle: automationTitleByConversation.get(id),
          conversation: root,
          durationMs: 0,
          firstHumanMessageText: firstHumanMessageTextByConversation.get(id),
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
