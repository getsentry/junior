const DEFAULT_AGENT_NAME = "Junior";

/** Return the agent name embedded in the dashboard shell. */
export function getDashboardAgentName(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_NAME;
  return window.__JUNIOR_DASHBOARD_AGENT_NAME__?.trim() || DEFAULT_AGENT_NAME;
}

/** Format the configured agent name as a possessive. */
export function agentNamePossessive(
  agentName = getDashboardAgentName(),
): string {
  return agentName.endsWith("s") ? `${agentName}'` : `${agentName}'s`;
}
