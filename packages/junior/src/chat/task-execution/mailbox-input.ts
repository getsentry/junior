import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";
import type { InboundMessage } from "@/chat/task-execution/store";

/** Join non-empty mailbox Message text for one Turn. */
export function joinMailboxText(messages: readonly InboundMessage[]): string {
  return messages
    .map((message) => message.input.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Return the Review items of a web batch when every Message reports one, so
 * the dashboard can show the saved Message as answers, not as prose.
 */
export function batchReviewItemIds(
  messages: readonly InboundMessage[],
): string[] | undefined {
  const ids = messages.map(
    (message) =>
      legacyWebMailboxMetadataSchema.safeParse(message.input.metadata).data
        ?.reviewItemId,
  );
  return ids.length > 0 && ids.every((id) => id !== undefined)
    ? ids
    : undefined;
}
