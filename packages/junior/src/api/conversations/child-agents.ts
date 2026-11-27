import type { User } from "@sentry/junior-plugin-api";
import { listChildAgents } from "@/chat/child-agents/list";
import { getConversationStore, getDb } from "@/chat/db";
import { throwApiError } from "../http";
import {
  type ConversationChildAgent,
  type ConversationChildAgentsReport,
} from "../schema/child-agent";
import { readConversationAccessFromSql } from "./access";
import { readConversationFeedFromSql } from "./list";

/**
 * Keep only the state, time, and usage of a child agent: no title, name,
 * summary, preview, or any other field that can hold private content. The
 * schema checks the result against `REDACTED_CHILD_AGENT_FIELDS`.
 */
function redactChildAgent(
  child: ConversationChildAgent,
): ConversationChildAgent {
  return {
    agentStatus: child.agentStatus,
    archivedAt: child.archivedAt,
    auxiliaryCosts: child.auxiliaryCosts,
    childAgentTotals: child.childAgentTotals,
    conversationId: child.conversationId,
    cumulativeDurationMs: child.cumulativeDurationMs,
    cumulativeUsage: child.cumulativeUsage,
    isParticipant: child.isParticipant,
    kind: child.kind,
    lastMessageAt: child.lastMessageAt,
    lastProgressAt: child.lastProgressAt,
    lastResult: child.lastResult,
    lastSeenAt: child.lastSeenAt,
    latestTurnFailed: child.latestTurnFailed,
    parentConversationId: child.parentConversationId,
    redacted: true,
    startedAt: child.startedAt,
    status: child.status,
    surface: child.surface,
    treeState: child.treeState,
    turnActive: child.turnActive,
    watching: child.watching,
  };
}

/**
 * Load the direct child agents of one Conversation as Conversation feed
 * rows, or throw a standard API not-found error. Viewers who cannot see the
 * parent's private content get only the state, time, and usage of each
 * child agent. Archived children stay in the report, so the dashboard can
 * show and restore them.
 */
export async function requireConversationChildAgents(
  conversationId: string,
  options: { viewer?: User | undefined } = {},
): Promise<ConversationChildAgentsReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const [accessByConversation, children] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listChildAgents(conversationId),
  ]);
  const canExposePayload =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;
  const feed =
    children.length > 0
      ? await readConversationFeedFromSql({
          children: {
            conversationIds: children.map((child) => child.childConversationId),
            parentConversationId: conversationId,
          },
          limit: children.length,
          ...(options.viewer ? { viewer: options.viewer } : undefined),
        })
      : undefined;
  const rowById = new Map(
    feed?.conversations.map((row) => [row.conversationId, row]),
  );

  // Keep the agent order: newest agent activity first.
  const conversations = children.flatMap((agent) => {
    const row = rowById.get(agent.childConversationId);
    if (!row) return [];
    const child: ConversationChildAgent = {
      ...row,
      agentStatus: agent.status,
      ...(agent.lastResult ? { lastResult: agent.lastResult } : undefined),
      ...(agent.agentName ? { name: agent.agentName } : undefined),
    };
    return [canExposePayload ? child : redactChildAgent(child)];
  });

  return { conversationId, conversations };
}
