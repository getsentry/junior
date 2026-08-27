/** Shared mailbox helpers for conversation-only turns. */
import type { InboundMessage } from "@/chat/task-execution/store";

/** Join non-empty mailbox texts for one conversation-only turn. */
export function joinMailboxText(messages: readonly InboundMessage[]): string {
  return messages
    .map((message) => message.input.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
