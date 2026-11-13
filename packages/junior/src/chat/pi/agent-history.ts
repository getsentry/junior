/**
 * Junior history inside a Pi agent's message list.
 *
 * Later Pi versions keep the system prompt and tool declarations in
 * `role: "system"` messages in `agent.state.messages`. The Agent puts the
 * leading one there from `initialState`. Junior builds its system prompt and
 * tools again for each slice, so system messages are never saved: Junior
 * history never contains them.
 *
 * - Read with `readAgentHistory`. It drops every system message.
 * - Write with `writeAgentHistory`. It keeps the leading system message of
 *   the current list, so Pi still sends the prompt and tools.
 *
 * Pi 0.85.1 adds no system messages, so both return a plain copy there.
 */
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { PiMessage } from "@/chat/pi/messages";

function isSystemMessage(message: PiMessage): boolean {
  return (message as { role?: unknown }).role === "system";
}

/** Return Junior history: the messages without Pi's system messages. */
export function readAgentHistory<T extends PiMessage>(
  messages: readonly T[],
): T[] {
  return messages.filter((message) => !isSystemMessage(message));
}

/**
 * Return the message list that replaces `current` with `history`. The leading
 * system message of `current` stays first. System messages in `history` are
 * dropped.
 */
export function writeAgentHistory(
  current: readonly PiMessage[],
  history: readonly PiMessage[],
): PiMessage[] {
  const leading = current[0];
  const messages = readAgentHistory(history);
  return leading && isSystemMessage(leading)
    ? [leading, ...messages]
    : messages;
}

/**
 * Give the stream path Junior's own system prompt and tools, with Junior
 * history as the messages. The traced stream and cache warming then read the
 * same request on every Pi version, without Pi's system messages.
 */
export function withAgentRequest(
  base: StreamFn,
  request: { systemPrompt: string; tools: AgentTool[] },
): StreamFn {
  return (model, context, options) =>
    base(
      model,
      {
        systemPrompt: request.systemPrompt,
        messages: readAgentHistory(context.messages),
        tools: request.tools,
      },
      options,
    );
}
