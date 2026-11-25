/**
 * Junior history inside a Pi agent's message list.
 *
 * Pi keeps the system prompt and tool declarations in `role: "system"`
 * messages in `agent.state.messages`. The Agent puts the leading one there
 * from `initialState`. Junior builds it again for each slice from the base
 * prompt and the Conversation's leading capability sections
 * (`agentSystemPrompt`), so it is never saved as history. A later system
 * message is history: a change to those sections. Junior saves it in order
 * and sends it again unchanged, because a changed or removed system message
 * breaks the provider cache.
 *
 * - Read with `readAgentHistory`. It drops the leading system message.
 * - Write with `writeAgentHistory`. It keeps the leading system message of
 *   the current list, so Pi still sends the prompt and tools.
 * - Change named sections with `systemSectionsUpdate`.
 * - Keep the changes with `systemSectionsChange` when a history replacement
 *   drops them.
 */
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  getSystemMessageText,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type SystemMessage,
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

/** Capability sections by name, as the leading system message holds them. */
export type SystemSections = Record<string, string>;

function leadingSectionsMessage(sections: SystemSections): SystemMessage {
  return { role: "system", content: "", sections, timestamp: 0 };
}

/**
 * Return the system prompt of every request in a Conversation: the base
 * prompt, then the leading capability sections. Neither changes after the
 * first Turn, so the cached prefix stays the same. Later changes are system
 * messages in history, which Pi sends right before the next assistant message.
 */
export function agentSystemPrompt(
  base: string,
  leading: SystemSections,
): string {
  return [base, getSystemMessageText(leadingSectionsMessage(leading))]
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// The leading sections with every system message of the history applied.
function currentSections(
  leading: SystemSections,
  history: readonly PiMessage[],
): Record<string, string | null> {
  return (
    getCurrentSystemMessage([leadingSectionsMessage(leading), ...history])
      ?.sections ?? {}
  );
}

/**
 * Return a system message that sets each section of `sections` that differs
 * from the leading sections with the history's changes applied, or none when
 * all match. A null section removes it; a section that is not set needs no
 * removal.
 */
export function systemSectionsUpdate(
  leading: SystemSections,
  history: readonly PiMessage[],
  sections: Record<string, string | null>,
  timestamp: number,
): SystemMessage | undefined {
  const current = currentSections(leading, history);
  const changed = Object.entries(sections).filter(
    ([name, value]) => (current[name] ?? null) !== value,
  );
  return changed.length > 0
    ? {
        role: "system",
        content: "",
        sections: Object.fromEntries(changed),
        timestamp,
      }
    : undefined;
}

/**
 * Return one system message with every change that the system messages of
 * `history` made to the leading sections, or none when they made none. A
 * history replacement that drops those messages keeps it, so the model keeps
 * the latest sections and the system prompt stays the same. Junior's leading
 * system message declares the tools, so tool changes are not kept.
 */
export function systemSectionsChange(
  leading: SystemSections,
  history: readonly PiMessage[],
): SystemMessage | undefined {
  const replayed = getCurrentSystemMessage(history);
  if (!replayed) return undefined;
  const current = currentSections(leading, history);
  const changed: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(leading)) {
    if (current[name] !== value) changed[name] = current[name] ?? null;
  }
  for (const [name, value] of Object.entries(current)) {
    if (!(name in leading)) changed[name] = value;
  }
  const hasSections = Object.keys(changed).length > 0;
  if (!replayed.content && !hasSections) return undefined;
  return {
    role: "system",
    content: replayed.content,
    ...(hasSections ? { sections: changed } : undefined),
    timestamp: replayed.timestamp,
  };
}

/**
 * Give the stream path Junior's own system prompt and tools, with Junior
 * history as the messages. The traced stream and cache warming then read the
 * same request on every Pi version. Saved system messages stay in place, and
 * Pi sends each one right before the next assistant message.
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
