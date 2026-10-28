import type { InboundMessage } from "@/chat/task-execution/store";

/** Join non-empty mailbox Message text for one Turn. */
export function joinMailboxText(messages: readonly InboundMessage[]): string {
  return messages
    .map((message) => message.input.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
