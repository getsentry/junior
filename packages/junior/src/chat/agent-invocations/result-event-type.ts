import type { TerminalAgentInvocation } from "./types";

// The parent message of each agent invocation result has an Event type with
// this prefix and the terminal status, such as `agent_invocation.blocked`.
const AGENT_INVOCATION_RESULT_EVENT_TYPE_PREFIX = "agent_invocation.";

/** Build the Event type of the parent message for one agent invocation result. */
export function agentInvocationResultEventType(
  status: TerminalAgentInvocation["status"],
): string {
  return `${AGENT_INVOCATION_RESULT_EVENT_TYPE_PREFIX}${status}`;
}

/** True when an Event type names an agent invocation result. */
export function isAgentInvocationResultEventType(eventType: string): boolean {
  return eventType.startsWith(AGENT_INVOCATION_RESULT_EVENT_TYPE_PREFIX);
}

/** Event type of the `reply` that ends a child agent's Turn. */
export const AGENT_REPLY_EVENT_TYPE = "agent.reply";
