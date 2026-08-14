/**
 * Pi transcript utilities.
 *
 * Shape predicates and durable-history manipulation for raw Pi messages,
 * shared by the agent executor and the services that persist, trim, or
 * summarize transcripts. The utilities here strip stale
 * `<runtime-turn-context>` bootstrap blocks before history is reused or
 * replaced; an active completed projection may retain its current bootstrap.
 */
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const RUNTIME_TURN_CONTEXT_START = `<${TURN_CONTEXT_TAG}>`;
const AGENTS_INSTRUCTIONS_START = "# AGENTS.md instructions";

function userMessageContent(message: PiMessage): unknown[] | undefined {
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
    ((part as { text: string }).text.startsWith(RUNTIME_TURN_CONTEXT_START) ||
      (part as { text: string }).text.startsWith(AGENTS_INSTRUCTIONS_START))
  );
}

function hasCurrentInstruction(message: PiMessage): boolean {
  return (
    userMessageContent(message)?.some(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string" &&
        (part as { text: string }).text.includes("<current-instruction"),
    ) ?? false
  );
}

function messageTimestamp(message: PiMessage): unknown {
  return (message as { timestamp?: unknown }).timestamp;
}

function isStandaloneRuntimeContextMessage(
  messages: PiMessage[],
  index: number,
): boolean {
  const message = messages[index];
  const next = messages[index + 1];
  return Boolean(
    message &&
    next &&
    userMessageContent(message) &&
    userMessageContent(next) &&
    messageTimestamp(message) === messageTimestamp(next) &&
    !hasCurrentInstruction(message) &&
    hasCurrentInstruction(next),
  );
}

// Prior-thread context blocks the runtime embeds beside the <current-instruction>
// block (see buildUserTurnText and renderThreadContextForPrompt). Each holds
// other participants' verbatim messages, so completed-run projections must drop
// them and keep only the instruction. Legacy tag names stay stripable for older
// durable history.
const EMBEDDED_THREAD_CONTEXT_TAGS = [
  "thread-context",
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

/** Return whether Pi can continue directly from the current history tail. */
export function isContinuablePiBoundary(
  messages: readonly PiMessage[],
): boolean {
  const lastRole = getPiMessageRole(messages.at(-1));
  return lastRole === "user" || lastRole === "toolResult";
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
  let lastNonAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isAssistantMessage(messages[index])) {
      lastNonAssistantIndex = index;
      break;
    }
  }

  return messages.slice(lastNonAssistantIndex + 1).filter(isAssistantMessage);
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

/** Return whether Pi history already carries session bootstrap context. */
export function hasRuntimeTurnContext(messages: PiMessage[]): boolean {
  return messages.some(
    (message, index) =>
      isStandaloneRuntimeContextMessage(messages, index) ||
      userMessageContent(message)?.some(isRuntimeTurnContextPart),
  );
}

/** Keep only volatile bootstrap messages needed by an in-turn context replacement. */
export function retainRuntimeTurnContext(messages: PiMessage[]): PiMessage[] {
  return messages.flatMap((message, index) => {
    if (isStandaloneRuntimeContextMessage(messages, index)) {
      return [message];
    }
    const runtimeContent =
      userMessageContent(message)?.filter(isRuntimeTurnContextPart) ?? [];
    return runtimeContent.length > 0
      ? [{ ...message, content: runtimeContent } as PiMessage]
      : [];
  });
}

/**
 * Reduce a runtime user-turn prompt to only the current turn's instruction.
 *
 * Live user prompts embed prior-thread context as `<thread-context
 * authority="evidence-only">` (or legacy transcript/background blocks) beside
 * the `<current-instruction>` block. Those blocks hold other participants'
 * verbatim messages, so completed-run projections consumed by plugins must
 * expose only the instruction authored by this turn's actor — otherwise
 * per-entry provenance can be defeated by reading another user's text out of an
 * instruction-authority entry. Prior thread context is projected separately as
 * per-author context-authority entries, so dropping it here is non-lossy for
 * plugins. This is projection-only; it never touches what the model sees during
 * a live run.
 */
export function instructionTextForProjection(text: string): string {
  // Prefer the instruction boundary first. Ambient bodies are escaped, but
  // older durable history may still embed raw tags; unwrapping avoids a lazy
  // context-strip match ending early on message text.
  const unwrapped = unwrapCurrentInstruction(text);
  if (unwrapped !== undefined) {
    return unwrapped;
  }
  const withoutContext = text
    .replace(EMBEDDED_THREAD_CONTEXT_PATTERN, "")
    .trim();
  return unwrapCurrentInstruction(withoutContext) ?? withoutContext;
}

/** Return the projected instruction text carried by one user message. */
export function getUserMessageInstructionText(message: PiMessage): string {
  if (getPiMessageRole(message) !== "user") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string"
                ? [(part as { text: string }).text]
                : [],
            )
            .join("\n")
        : "";
  return instructionTextForProjection(text).trim();
}

/** Remove volatile runtime context before reusing messages as history. */
export function stripRuntimeTurnContext(messages: PiMessage[]): PiMessage[] {
  return messages.flatMap((message, index) => {
    if (isStandaloneRuntimeContextMessage(messages, index)) {
      return [];
    }
    const content = userMessageContent(message);
    if (!content) return [message];

    const nextContent = content.filter(
      (part) => !isRuntimeTurnContextPart(part),
    );
    if (nextContent.length === content.length) return [message];
    if (nextContent.length === 0) return [];
    return [{ ...message, content: nextContent } as PiMessage];
  });
}
