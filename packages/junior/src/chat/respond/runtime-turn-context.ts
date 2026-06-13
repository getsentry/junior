import type { PiMessage } from "@/chat/pi/messages";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const RUNTIME_TURN_CONTEXT_START = `<${TURN_CONTEXT_TAG}>`;

function getUserMessageContent(message: PiMessage): unknown[] | undefined {
  const record = message as { role?: unknown; content?: unknown };
  return record.role === "user" && Array.isArray(record.content)
    ? record.content
    : undefined;
}

function isRuntimeTurnContextPart(part: unknown, marker: string): boolean {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.startsWith(marker)
  );
}

function prependRuntimeTurnContext(
  message: PiMessage,
  turnContextPrompt: string,
): PiMessage | undefined {
  const content = getUserMessageContent(message);
  if (!content) {
    return undefined;
  }

  const contextIndex = content.findIndex((part) =>
    isRuntimeTurnContextPart(part, RUNTIME_TURN_CONTEXT_START),
  );
  if (contextIndex >= 0) {
    return undefined;
  }

  return {
    ...message,
    content: [{ type: "text", text: turnContextPrompt }, ...content],
  } as PiMessage;
}

/** Add bootstrap context only for stored boundaries captured before prompt(). */
export function prependMissingRuntimeTurnContext(
  messages: PiMessage[],
  turnContextPrompt: string,
): PiMessage[] {
  if (hasRuntimeTurnContext(messages)) {
    return messages;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const updated = prependRuntimeTurnContext(
      messages[index],
      turnContextPrompt,
    );
    if (!updated) {
      continue;
    }

    const nextMessages = [...messages];
    nextMessages[index] = updated;
    return nextMessages;
  }

  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: turnContextPrompt }],
      timestamp: Date.now(),
    } as PiMessage,
  ];
}

/** Return whether Pi history already carries session bootstrap context. */
export function hasRuntimeTurnContext(messages: PiMessage[]): boolean {
  return messages.some((message) =>
    getUserMessageContent(message)?.some((part) =>
      isRuntimeTurnContextPart(part, RUNTIME_TURN_CONTEXT_START),
    ),
  );
}

/** Remove volatile runtime context before reusing messages as history. */
export function stripRuntimeTurnContext(messages: PiMessage[]): PiMessage[] {
  return messages.flatMap((message) => {
    const content = getUserMessageContent(message);
    if (!content) {
      return [message];
    }

    const nextContent = content.filter(
      (part) => !isRuntimeTurnContextPart(part, RUNTIME_TURN_CONTEXT_START),
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
