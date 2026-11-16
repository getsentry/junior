// The shell always embeds the configured name. Only code that renders
// outside a browser, such as tests, sees this neutral fallback.
const DEFAULT_AGENT_NAME = "Assistant";

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
