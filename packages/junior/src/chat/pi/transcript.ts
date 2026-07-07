/**
 * Pi transcript utilities.
 *
 * Shape predicates and durable-history manipulation for raw Pi messages,
 * shared by the agent executor and the services that persist, trim, or
 * summarize transcripts. Volatile runtime turn context (the
 * `<runtime-turn-context>` bootstrap block) is stripped here so durable
 * history never retains per-session runtime instructions as user text.
 */
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const RUNTIME_TURN_CONTEXT_START = `<${TURN_CONTEXT_TAG}>`;

// Prior-thread context blocks the runtime embeds inside the same user-turn text
// that carries the <current-instruction> block (see buildUserTurnText and
// buildConversationContext). Each holds other participants' verbatim messages,
// so completed-run projections must drop them and keep only the instruction.
const EMBEDDED_THREAD_CONTEXT_TAGS = [
  "recent-thread-messages",
  "thread-compactions",
  "thread-transcript",
  "thread-background",
] as const;

const EMBEDDED_THREAD_CONTEXT_PATTERN = new RegExp(
  `<(${EMBEDDED_THREAD_CONTEXT_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`,
  "g",
);

/** Type guard for Pi SDK assistant messages. */
export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "assistant"
  );
}

/** Type guard for Pi SDK tool result messages. */
export function isToolResultMessage(
  value: unknown,
): value is ToolResultMessage<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "toolResult"
  );
}

/** Check whether a tool result carries an error flag. */
export function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean((result as { isError?: unknown }).isError);
}

/** Extract the tool name from a raw tool result message. */
export function normalizeToolNameFromResult(
  result: unknown,
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { toolName?: unknown; name?: unknown };
  if (typeof record.toolName === "string" && record.toolName.length > 0) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.length > 0) {
    return record.name;
  }
  return undefined;
}

/** Extract role string from a raw Pi message. */
export function getPiMessageRole(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** Concatenate text content parts from an assistant message. */
export function extractAssistantText(message: AssistantMessage): string {
  const content =
    (message as { content?: Array<{ type?: unknown; text?: unknown }> })
      .content ?? [];
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Return assistant messages that belong to the terminal post-tool reply phase. */
export function getTerminalAssistantMessages(
  messages: readonly unknown[],
): AssistantMessage[] {
  let lastToolResultIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isToolResultMessage(messages[index])) {
      lastToolResultIndex = index;
      break;
    }
  }

  return messages.slice(lastToolResultIndex + 1).filter(isAssistantMessage);
}

/** Remove trailing assistant messages before committing a resumable boundary. */
export function trimTrailingAssistantMessages(
  messages: PiMessage[],
): PiMessage[] {
  let end = messages.length;
  while (end > 0 && getPiMessageRole(messages[end - 1]) === "assistant") {
    end -= 1;
  }
  return end === messages.length ? [...messages] : messages.slice(0, end);
}

function getUserMessageContent(message: PiMessage): unknown[] | undefined {
  const record = message as { role?: unknown; content?: unknown };
  return record.role === "user" && Array.isArray(record.content)
    ? record.content
    : undefined;
}

function isRuntimeTurnContextPart(part: unknown): boolean {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.startsWith(RUNTIME_TURN_CONTEXT_START)
  );
}

/** Return whether Pi history already carries session bootstrap context. */
export function hasRuntimeTurnContext(messages: PiMessage[]): boolean {
  return messages.some((message) =>
    getUserMessageContent(message)?.some((part) =>
      isRuntimeTurnContextPart(part),
    ),
  );
}

/**
 * Reduce a runtime user-turn prompt to only the current turn's instruction.
 *
 * Live user prompts embed prior-thread context blocks (`<thread-transcript>`,
 * `<recent-thread-messages>`, `<thread-compactions>`, `<thread-background>`) in
 * the same message that carries the `<current-instruction>` block. Those blocks
 * hold other participants' verbatim messages, so completed-run projections
 * consumed by plugins must expose only the instruction authored by this turn's
 * actor — otherwise per-entry provenance can be defeated by reading another
 * user's text out of an instruction-authority entry. Prior thread context is
 * projected separately as per-author context-authority entries, so dropping it
 * here is non-lossy for plugins. This is projection-only; it never touches what
 * the model sees during a live run.
 */
export function instructionTextForProjection(text: string): string {
  const withoutContext = text
    .replace(EMBEDDED_THREAD_CONTEXT_PATTERN, "")
    .trim();
  return unwrapCurrentInstruction(withoutContext) ?? withoutContext;
}

/** Remove volatile runtime context before reusing messages as history. */
export function stripRuntimeTurnContext(messages: PiMessage[]): PiMessage[] {
  return messages.flatMap((message) => {
    const content = getUserMessageContent(message);
    if (!content) {
      return [message];
    }

    const nextContent = content.filter(
      (part) => !isRuntimeTurnContextPart(part),
    );
    if (nextContent.length === content.length) {
      return [message];
    }
    if (nextContent.length === 0) {
      return [];
    }
    return [{ ...message, content: nextContent } as PiMessage];
  });
}
