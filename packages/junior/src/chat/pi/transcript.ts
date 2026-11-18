/**
 * Pi transcript utilities.
 *
 * Shape predicates and message projections for raw Pi messages, shared by the
 * agent executor and services that compare, summarize, or replace history.
 * Normal model replay keeps `<runtime-turn-context>` unchanged. Narrow
 * projections can omit it when they do not represent model history.
 */
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { openingTag, stripTags } from "@sentry/junior-plugin-api";
import {
  hasCurrentInstruction,
  unwrapCurrentInstruction,
} from "@/chat/current-instruction";
import {
  isRuntimeInputText,
  readParentAgentTask,
  THREAD_CONTEXT_TAGS,
} from "@/chat/input-tags";
import type { PiMessage } from "@/chat/pi/messages";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const RUNTIME_TURN_CONTEXT_START = openingTag(TURN_CONTEXT_TAG);
const AGENTS_INSTRUCTIONS_START = "# AGENTS.md instructions";

/** Starts of user text parts that hold runtime context, not a person's words. */
export const RUNTIME_CONTEXT_TEXT_STARTS = [
  RUNTIME_TURN_CONTEXT_START,
  AGENTS_INSTRUCTIONS_START,
] as const;

type UserContentPart = Exclude<UserMessage["content"], string>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function userMessageContent(message: PiMessage): UserContentPart[] | undefined {
  return message.role === "user" && Array.isArray(message.content)
    ? message.content
    : undefined;
}

/** The message with other content parts, if it is a user message. */
function withUserContent(
  message: PiMessage,
  content: UserContentPart[],
): PiMessage {
  return message.role === "user" ? { ...message, content } : message;
}

// Stored history is parsed only by role, so a part's text is still checked.
function textPartValue(part: UserContentPart): string | undefined {
  return part.type === "text" && typeof part.text === "string"
    ? part.text
    : undefined;
}

function isRuntimeTurnContextPart(part: UserContentPart): boolean {
  const text = textPartValue(part);
  return (
    text !== undefined &&
    RUNTIME_CONTEXT_TEXT_STARTS.some((start) => text.startsWith(start))
  );
}

/**
 * Whether a user message carries a Turn input, not only context: a
 * `<current-instruction>` or a runtime input tag such as `<task>`.
 */
export function hasTurnInput(message: PiMessage): boolean {
  return (
    userMessageContent(message)?.some((part) => {
      const text = textPartValue(part);
      return (
        text !== undefined &&
        (hasCurrentInstruction(text) || isRuntimeInputText(text))
      );
    }) ?? false
  );
}

/** Return whether the message is a Turn's context, paired with the instruction after it. */
export function isStandaloneRuntimeContextMessage(
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
    message.timestamp === next.timestamp &&
    !hasTurnInput(message) &&
    hasTurnInput(next),
  );
}

/** Type guard for Pi SDK assistant messages. */
export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value) && value["role"] === "assistant";
}

/** Type guard for Pi SDK tool result messages. */
export function isToolResultMessage(
  value: unknown,
): value is ToolResultMessage {
  return isRecord(value) && value["role"] === "toolResult";
}

/** Check whether a tool result carries an error flag. */
export function isToolResultError(result: unknown): boolean {
  return isRecord(result) && Boolean(result["isError"]);
}

/** Extract the tool name from a raw tool result message. */
export function normalizeToolNameFromResult(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) return undefined;
  const { name, toolName } = result;
  if (typeof toolName === "string" && toolName.length > 0) return toolName;
  if (typeof name === "string" && name.length > 0) return name;
  return undefined;
}

/** Extract role string from a raw Pi message. */
export function getPiMessageRole(value: unknown): string | undefined {
  return isRecord(value) && typeof value["role"] === "string"
    ? value["role"]
    : undefined;
}

/** Return whether Pi can continue directly from the current history tail. */
export function isContinuablePiBoundary(
  messages: readonly PiMessage[],
): boolean {
  // A saved system message applies to the next model call, so the message
  // before it decides.
  let end = messages.length;
  while (end > 0 && getPiMessageRole(messages[end - 1]) === "system") {
    end -= 1;
  }
  const lastRole = getPiMessageRole(messages[end - 1]);
  return lastRole === "user" || lastRole === "toolResult";
}

/** Concatenate text content parts from an assistant message. */
export function extractAssistantText(message: AssistantMessage): string {
  return (message.content ?? [])
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
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
      ? [withUserContent(message, runtimeContent)]
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
  // Drop ambient envelopes first, then read the instruction. Unwrapping before
  // strip would let ambient text that embeds a full <current-instruction>
  // block win over the real turn instruction.
  const withoutContext = stripTags(text, THREAD_CONTEXT_TAGS).trim();
  return unwrapCurrentInstruction(withoutContext) ?? withoutContext;
}

/**
 * Return the projected input text carried by one user message. Each Turn
 * input is its own content part: a `<current-instruction>` gives its body,
 * and a runtime input tag stays as it is. Other parts, such as attachments,
 * are dropped. A message with no input part keeps the projection of all its
 * text.
 */
export function getUserMessageInstructionText(message: PiMessage): string {
  if (message.role !== "user") {
    return "";
  }
  const texts =
    typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => textPartValue(part) ?? []);
  const inputs = texts.flatMap((text) => {
    const withoutContext = stripTags(text, THREAD_CONTEXT_TAGS).trim();
    if (isRuntimeInputText(withoutContext)) {
      return [readParentAgentTask(withoutContext) ?? withoutContext];
    }
    const instruction = unwrapCurrentInstruction(withoutContext);
    return instruction === undefined ? [] : [instruction.trim()];
  });
  if (inputs.length > 0) {
    return inputs.filter(Boolean).join("\n\n");
  }
  return instructionTextForProjection(texts.join("\n")).trim();
}

/** Remove runtime context from a non-model projection or explicit replacement. */
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
    return [withUserContent(message, nextContent)];
  });
}
