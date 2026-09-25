import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    );
  }
  return value;
}

/** Keep tool arguments byte-stable before and after SQL history replay. */
export function toModelMessages(messages: AgentMessage[]): Message[] {
  return messages
    .filter(
      (message): message is Message =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult",
    )
    .map((message) => {
      if (message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "toolCall"
            ? {
                ...part,
                // jsonb reorders keys. Sort every request, not only replay,
                // without changing stored history or tool execution input.
                arguments: sortObjectKeys(part.arguments) as Record<
                  string,
                  unknown
                >,
              }
            : part,
        ),
      };
    });
}
