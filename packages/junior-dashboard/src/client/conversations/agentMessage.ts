import { readTag, unescapeTagText } from "@sentry/junior-plugin-api";
import { isAgentMessageEventType } from "@sentry/junior/api/schema";
import * as z from "zod";

import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewToolCallPart,
} from "../types";

/**
 * What happened to a sent message. `delivered`: the target started work on
 * it. `queued`: the target reads it at its next step or after its current
 * work. `noted`: the target is stopped, so it got the message as a
 * Conversation note and started no work. `refused`: the tool call failed,
 * such as for a target that this agent cannot message.
 */
export type AgentMessageDelivery =
  | "delivered"
  | "noted"
  | "queued"
  | "refused"
  | "sending";

/** One message between two agents, as the transcript row shows it. */
export type AgentMessage = {
  /** The other Conversation: the target of a sent message, or the sender. */
  conversationId?: string | undefined;
  delivery?: AgentMessageDelivery | undefined;
  direction: "received" | "sent";
  /** Absent when the viewer cannot read the message. */
  text?: string | undefined;
  /** The `to` of a sent message, such as `parent` or a child agent name. */
  to?: string | undefined;
};

const MESSAGE_AGENT_TOOL_NAME = "messageAgent";
const PARENT_AGENT_TARGET = "parent";

const messageAgentInputSchema = z.object({
  text: z.string(),
  to: z.string().min(1),
});
const messageAgentOutputSchema = z.object({
  conversation_id: z.string().min(1),
  delivery: z.enum(["started", "queued", "noted"]),
});

const deliveryByToolResult = {
  noted: "noted",
  queued: "queued",
  started: "delivered",
} as const satisfies Record<string, AgentMessageDelivery>;

/**
 * True for a tool that sends a message to another agent. Its call shows as
 * a message row, never as a child's card.
 */
export function isAgentMessageTool(name: string | undefined): boolean {
  return name === MESSAGE_AGENT_TOOL_NAME;
}

/** True for a `messageAgent` call whose arguments the viewer can read. */
export function isSentAgentMessage(part: TranscriptViewToolCallPart): boolean {
  return sentAgentMessage(part) !== undefined;
}

/**
 * Read a `messageAgent` call as a sent message. Returns undefined for other
 * tools and for a call whose arguments the transcript hides, which then
 * shows as a tool call.
 */
export function sentAgentMessage(
  part: TranscriptViewToolCallPart,
): AgentMessage | undefined {
  if (!isAgentMessageTool(part.name)) return undefined;
  const input = messageAgentInputSchema.safeParse(part.input);
  if (!input.success) return undefined;
  const output =
    part.status === "completed" ? messageAgentOutput(part.output) : undefined;
  return {
    conversationId: output?.conversation_id,
    delivery:
      part.status === "running"
        ? "sending"
        : part.status === "error"
          ? "refused"
          : output && deliveryByToolResult[output.delivery],
    direction: "sent",
    text: input.data.text,
    to: input.data.to,
  };
}

type ReceivedMessage = Pick<
  TranscriptViewMessage,
  "eventIdentifier" | "eventType" | "fromParentAgent" | "parts" | "role"
>;

/** True for a message that another agent sent to this Conversation. */
export function isReceivedAgentMessage(
  message: TranscriptViewMessage,
): boolean {
  return receivedAgentMessage(message) !== undefined;
}

/**
 * Read a message that another agent sent to this Conversation: a Parent
 * message, including a child's first task, a child agent's message to its
 * parent, or a message from another top-level agent. Returns undefined for
 * other messages.
 */
export function receivedAgentMessage(
  message: ReceivedMessage,
): AgentMessage | undefined {
  if (message.role !== "user") return undefined;
  const text = message.parts.find((part) => part.type === "text")?.text;
  // A Watch Event that reaches a child is not a Parent message.
  if (message.fromParentAgent && !message.eventType) {
    return {
      direction: "received",
      text,
      to: PARENT_AGENT_TARGET,
    };
  }
  if (!message.eventType || !isAgentMessageEventType(message.eventType)) {
    return undefined;
  }
  return {
    conversationId: message.eventIdentifier,
    direction: "received",
    text: text === undefined ? undefined : agentMessageInputText(text),
  };
}

/**
 * Return the words of a received message without the `<agent-message>` tag
 * that core writes around them for the model. The first body line says who
 * wrote it. Other text stays as stored.
 */
function agentMessageInputText(text: string): string {
  const body = readTag(text, "agent-message");
  if (body === undefined) return text;
  return unescapeTagText(body.split("\n").slice(1).join("\n"));
}

/**
 * Name the other Conversation of a message from what this transcript
 * already holds: the agent tree above it, then the child agents that it
 * started, by id or by the agent name that `to` can use. The viewer can read
 * each of them, so no title leaks. Without one, a neutral label names it.
 */
export function agentMessageConversationTitle(
  conversation: Pick<ConversationTranscript, "agentTree" | "events">,
  message: Pick<AgentMessage, "conversationId" | "to">,
): string {
  const ids = [message.conversationId, message.to].filter(Boolean);
  const ancestor = conversation.agentTree?.find((node) =>
    ids.includes(node.conversationId),
  );
  if (ancestor) return ancestor.label;
  // The tree ends with this Conversation, so its parent is the node before.
  // A message to `parent` has no target id until its result arrives.
  const parent =
    message.to === PARENT_AGENT_TARGET
      ? conversation.agentTree?.at(-2)
      : undefined;
  if (parent) return parent.label;
  for (const event of conversation.events) {
    const data = event.data;
    if (data.type !== "subagent") continue;
    const named = message.to !== undefined && data.agentName === message.to;
    if (!named && !ids.includes(data.childConversationId)) continue;
    const title = data.title ?? data.agentName;
    if (title) return title;
  }
  return "Conversation";
}

/** Read a `messageAgent` result, which can be JSON text. */
function messageAgentOutput(
  output: unknown,
): z.infer<typeof messageAgentOutputSchema> | undefined {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  return messageAgentOutputSchema.safeParse(value).data;
}
