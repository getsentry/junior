import { isEventMailboxMetadata } from "@/chat/events/notification";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { TerminalAgentInvocation } from "./types";

/** Event namespace of the messages between a parent and its child agents. */
export const AGENT_INVOCATION_EVENT_NAMESPACE = "junior";

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

/**
 * Return whether a child agent sent this message to its parent: a result, a
 * `reply`, or a message.
 */
export function isChildAgentInputMessage(message: InboundMessage): boolean {
  const metadata = message.input.metadata;
  return (
    isEventMailboxMetadata(metadata) &&
    metadata.event.namespace === AGENT_INVOCATION_EVENT_NAMESPACE
  );
}
