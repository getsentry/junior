import type { User } from "@sentry/junior-plugin-api";
import { listChildAgents } from "@/chat/agent-invocations/store";
import { getConversationStore, getDb } from "@/chat/db";
import { throwApiError } from "../http";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgentsReport,
} from "../schema/child-agent";
import { readConversationAccessFromSql } from "./access";

/**
 * Load the direct child agents of one Conversation, or throw a standard API
 * not-found error. Viewers who cannot see private content get only the status
 * and time of each child agent.
 */
export async function requireConversationChildAgents(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationChildAgentsReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const access = (
    await readConversationAccessFromSql(
      getDb(),
      [conversationId],
      options.viewer,
    )
  ).get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;

  const agents = (await listChildAgents(conversationId)).map((agent) => ({
    conversationId: agent.childConversationId,
    status: agent.status,
    updatedAt: new Date(agent.updatedAtMs).toISOString(),
    ...(canExposePayload
      ? {
          ...(agent.agentName ? { name: agent.agentName } : undefined),
          task: agent.task,
          ...(agent.errorMessage ? { error: agent.errorMessage } : undefined),
        }
      : { redacted: true as const }),
  }));

  return conversationChildAgentsReportSchema.parse({ agents, conversationId });
}
