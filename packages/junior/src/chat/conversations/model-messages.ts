/** Shape-only utilities for opaque model messages stored in conversation events. */
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import type { ConversationModelMessage } from "./history";

const RUNTIME_TURN_CONTEXT_START = `<${TURN_CONTEXT_TAG}>`;

function userMessageContent(
  message: ConversationModelMessage,
): unknown[] | undefined {
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

/** Return whether opaque model history carries volatile runtime bootstrap context. */
export function hasRuntimeTurnContextMessages(
  messages: ConversationModelMessage[],
): boolean {
  return messages.some((message) =>
    userMessageContent(message)?.some(isRuntimeTurnContextPart),
  );
}

/** Keep only volatile runtime bootstrap messages needed during context replacement. */
export function retainRuntimeTurnContextMessages<
  T extends ConversationModelMessage,
>(messages: T[]): T[] {
  return messages.flatMap((message) => {
    const runtimeContent =
      userMessageContent(message)?.filter(isRuntimeTurnContextPart) ?? [];
    return runtimeContent.length > 0
      ? ([{ ...message, content: runtimeContent }] as T[])
      : [];
  });
}

/** Remove volatile runtime bootstrap parts without interpreting provider fields. */
export function stripRuntimeTurnContextMessages<
  T extends ConversationModelMessage,
>(messages: T[]): T[] {
  return messages.flatMap((message) => {
    const content = userMessageContent(message);
    if (!content) return [message];

    const nextContent = content.filter(
      (part) => !isRuntimeTurnContextPart(part),
    );
    if (nextContent.length === content.length) return [message];
    if (nextContent.length === 0) return [];
    return [{ ...message, content: nextContent } as T];
  });
}
