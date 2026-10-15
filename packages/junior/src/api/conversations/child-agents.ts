import type { User } from "@sentry/junior-plugin-api";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { getConversationStore, getDb } from "@/chat/db";
import { throwApiError } from "../http";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgentsReport,
} from "../schema/child-agent";
import { readConversationAccessFromSql } from "./access";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";
import {
  childAgentTotalsReport,
  readConversationTreeMetricsFromSql,
} from "./usage";

/**
 * Load the direct child agents of one Conversation, or throw a standard API
 * not-found error. Viewers who cannot see private content get only the status,
 * time, and usage of each child agent.
 */
export async function requireConversationChildAgents(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationChildAgentsReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const db = getDb();
  const [accessByConversation, children] = await Promise.all([
    readConversationAccessFromSql(db, [conversationId], options.viewer),
    listChildAgents(conversationId),
  ]);
  const canExposePayload =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;
  // Match the child Conversation detail: count the child and its own child
  // agents at any depth.
  const childIds = children.map((agent) => agent.childConversationId);
  const [metricsByChild, auxiliaryCostsByChild] = await Promise.all([
    readConversationTreeMetricsFromSql(db, childIds),
    readConversationAuxiliaryCostsFromSql(db, childIds),
  ]);

  const agents = children.map((agent) => {
    const metrics = metricsByChild.get(agent.childConversationId);
    const auxiliaryCosts = auxiliaryCostsByChild.get(agent.childConversationId);
    const childAgentTotals = childAgentTotalsReport(metrics, auxiliaryCosts);
    return {
      conversationId: agent.childConversationId,
      cumulativeDurationMs: metrics?.durationMs ?? 0,
      ...(metrics?.usage ? { cumulativeUsage: metrics.usage } : undefined),
      ...(auxiliaryCosts
        ? { auxiliaryCosts: auxiliaryCosts.total }
        : undefined),
      ...(childAgentTotals ? { childAgentTotals } : undefined),
      status: agent.status,
      updatedAt: new Date(agent.updatedAtMs).toISOString(),
      ...(canExposePayload
        ? {
            ...(agent.agentName ? { name: agent.agentName } : undefined),
            task: agent.task,
            ...(agent.title ? { title: agent.title } : undefined),
            ...(agent.errorMessage ? { error: agent.errorMessage } : undefined),
          }
        : { redacted: true as const }),
    };
  });

  return conversationChildAgentsReportSchema.parse({ agents, conversationId });
}
