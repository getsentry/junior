import { inArray } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { listChildAgents } from "@/chat/agent-invocations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { throwApiError } from "../http";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgentsReport,
} from "../schema/child-agent";
import { readConversationAccessFromSql } from "./access";
import { readConversationAuxiliaryCostsFromSql } from "./auxiliary-costs";

interface ChildConversationMetrics {
  durationMs: number;
  usage?: AgentTurnUsage;
}

/** Read the runtime and usage that each child Conversation saved itself. */
async function readChildConversationMetrics(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ChildConversationMetrics>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      durationMs: juniorConversations.durationMs,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
  return new Map(
    rows.map((row) => [
      row.conversationId,
      {
        durationMs: row.durationMs,
        ...(hasAgentTurnUsage(row.usage ?? undefined)
          ? { usage: row.usage! }
          : undefined),
      },
    ]),
  );
}

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
  // Match the child Conversation detail: count only the child's own work.
  const childIds = children.map((agent) => agent.childConversationId);
  const [metricsByChild, auxiliaryCostsByChild] = await Promise.all([
    readChildConversationMetrics(db, childIds),
    readConversationAuxiliaryCostsFromSql(db, childIds, {
      includeDescendants: false,
    }),
  ]);

  const agents = children.map((agent) => {
    const metrics = metricsByChild.get(agent.childConversationId);
    const auxiliaryCosts = auxiliaryCostsByChild.get(agent.childConversationId);
    return {
      conversationId: agent.childConversationId,
      cumulativeDurationMs: metrics?.durationMs ?? 0,
      ...(metrics?.usage ? { cumulativeUsage: metrics.usage } : undefined),
      ...(auxiliaryCosts ? { auxiliaryCosts } : undefined),
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
