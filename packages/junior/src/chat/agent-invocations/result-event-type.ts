/** Event namespace of the messages between a parent and its child agents. */
export const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";

// The result of an Agent invocation, which an earlier release wrote, has an
// Event type with this prefix and its status, such as
// `agent_invocation.blocked`. Stored transcripts still have them.
const AGENT_INVOCATION_RESULT_EVENT_TYPE_PREFIX = "agent_invocation.";

/** True when an Event type names an agent invocation result. */
export function isAgentInvocationResultEventType(eventType: string): boolean {
  return eventType.startsWith(AGENT_INVOCATION_RESULT_EVENT_TYPE_PREFIX);
}

/** Event type of the `reply` that ends a child agent's Turn. */
export const AGENT_REPLY_EVENT_TYPE = "agent.reply";

/** Event type of a message that a child agent sends to its parent. */
export const AGENT_MESSAGE_EVENT_TYPE = "agent.message";
