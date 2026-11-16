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
 * - Change named sections with `systemSectionsUpdate`.
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
 * Return a system message that sets each section of `sections` that differs
 * from the current state of Junior history, or none when all match. A null
 * section removes it; a section that history does not have needs no removal.
 */
export function systemSectionsUpdate(
  history: readonly PiMessage[],
  sections: Record<string, string | null>,
  timestamp: number,
): SystemMessage | undefined {
  const current = getCurrentSystemMessage(history)?.sections ?? {};
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

// Anthropic wants instructions that apply from the start in the top-level
// system prompt. Pi sends a later system message only before the next
// assistant message, so the sections of a first Turn would land after its
// prompt. Fold the system messages before the first assistant message into
// the system prompt instead. They do not change after that Turn, so the
// cached prefix stays the same.
function foldLeadingSystemMessages(
  systemPrompt: string,
  history: PiMessage[],
): Pick<Context, "systemPrompt" | "messages"> {
  const firstAssistant = history.findIndex(
    (message) => message.role === "assistant",
  );
  const end = firstAssistant === -1 ? history.length : firstAssistant;
  const leading = getCurrentSystemMessage(history.slice(0, end));
  return {
    systemPrompt: leading
      ? [systemPrompt, getSystemMessageText(leading)]
          .filter((text) => text.length > 0)
          .join("\n\n")
      : systemPrompt,
    messages: history.filter(
      (message, index) => index >= end || !isSystemMessage(message),
    ),
  };
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
        ...foldLeadingSystemMessages(
          request.systemPrompt,
          readAgentHistory(context.messages),
        ),
        tools: request.tools,
      },
      options,
    );
}
