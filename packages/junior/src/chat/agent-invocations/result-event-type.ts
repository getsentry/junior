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

/**
 * Event type of an agent update: what a Conversation reports when a Turn
 * ends, it waits on a person, or it stops. A parent gets it from its child
 * agents, and a Watch on the Conversation gets the same Event.
 */
export const AGENT_UPDATE_EVENT_TYPE = "agent.update";

// The Event type of a child's result before agent updates. Stored
// transcripts and input queued before the deploy still have it.
const LEGACY_AGENT_REPLY_EVENT_TYPE = "agent.reply";

/** True when an Event type names an agent update. */
export function isAgentUpdateEventType(eventType: string): boolean {
  return (
    eventType === AGENT_UPDATE_EVENT_TYPE ||
    eventType === LEGACY_AGENT_REPLY_EVENT_TYPE
  );
}

/** Event type of a message that a child agent sends to its parent. */
export const AGENT_MESSAGE_EVENT_TYPE = "agent.message";
