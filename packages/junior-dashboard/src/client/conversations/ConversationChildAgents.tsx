import { useQuery } from "@tanstack/react-query";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import type { StatusChipTone } from "../components/StatusChip";
import { revalidatedJsonQuery } from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";

const statusTones: Partial<Record<string, StatusChipTone>> = {
  active: "info",
  blocked: "warning",
  completed: "success",
  error: "danger",
  failed: "danger",
  needs_input: "warning",
  paused: "info",
  running: "info",
};

/** Pick the status tone for a child agent, its transcript row, or its detail. */
export function subagentStatusTone(status: string): StatusChipTone {
  return statusTones[status] ?? "neutral";
}

/**
 * Name what a child agent does now. Once it is idle, its last result says
 * more, such as `blocked`.
 */
export function childAgentStatusLabel(
  agent: Pick<ConversationChildAgent, "agentStatus" | "lastResult">,
): string {
  return agent.agentStatus === "idle"
    ? (agent.lastResult ?? agent.agentStatus)
    : agent.agentStatus;
}

/** Load the child agents of one Conversation with runtime status. */
export function useConversationChildAgents(
  conversationId: string,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryFn: revalidatedJsonQuery(
      conversationChildAgentsReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/agents`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "agents"),
    retry: false,
  });
}
