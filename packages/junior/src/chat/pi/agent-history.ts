/**
 * Junior history inside a Pi agent's message list.
 *
 * Pi keeps the system prompt and tool declarations in `role: "system"`
 * messages in `agent.state.messages`. The Agent puts the leading one there
 * from `initialState`. Junior builds its system prompt and tools again for
 * each slice, so the leading system message is never saved. A later system
 * message is history: Junior saves it in order and sends it again unchanged,
 * because a changed or removed system message breaks the provider cache.
 *
 * - Read with `readAgentHistory`. It drops the leading system message.
 * - Write with `writeAgentHistory`. It keeps the leading system message of
 *   the current list, so Pi still sends the prompt and tools.
 * - Fold with `foldSystemMessages` when a history replacement drops them.
 */
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { PiMessage } from "@/chat/pi/messages";

/**
 * A stream function that takes Junior's request: its system prompt, tools,
 * and history as a pi-ai `Context`. Pi's `StreamFn` takes Pi's transcript
 * instead. Everything below `withAgentRequest` uses this type, and pi-ai's
 * `streamSimple` turns the Context into the provider request.
 */
export type AgentRequestStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

function isSystemMessage(message: PiMessage | undefined): boolean {
  return (message as { role?: unknown } | undefined)?.role === "system";
}

/** Return Junior history: Pi's messages without its leading system message. */
export function readAgentHistory<T extends PiMessage>(
  messages: readonly T[],
): T[] {
  return isSystemMessage(messages[0]) ? messages.slice(1) : [...messages];
}

/**
 * Return the message list that replaces `current` with `history`. The leading
 * system message of `current` stays first. `history` is Junior history, so
 * each system message in it is a saved later one and stays in place.
 */
export function writeAgentHistory(
  current: readonly PiMessage[],
  history: readonly PiMessage[],
): PiMessage[] {
  const leading = current[0];
  return leading && isSystemMessage(leading)
    ? [leading, ...history]
    : [...history];
}

/**
 * Fold the system messages of Junior history into one system message with
 * their current content and sections, or none when they hold neither. A
 * history replacement that drops them keeps it, so the model keeps the
 * latest sections. Junior's leading system message declares the tools and no
 * sections, so tool changes are not kept and a removed section is left out.
 */
export function foldSystemMessages(
  history: readonly PiMessage[],
): PiMessage | undefined {
  const current = getCurrentSystemMessage(history);
  if (!current) return undefined;
  const { toolsAdded: _, ...folded } = current;
  return folded.content || folded.sections ? folded : undefined;
}

/**
 * Give the stream path Junior's own system prompt and tools, with Junior
 * history as the messages. The traced stream and cache warming then read the
 * same request on every Pi version, with saved system messages in place.
 */
export function withAgentRequest(
  base: AgentRequestStreamFn,
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
