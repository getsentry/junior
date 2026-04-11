import type { Message } from "chat";

/**
 * Preserve the native Slack message timestamp when a synthetic message ID is
 * used for routing or deduplication.
 */
export function getSlackMessageTs(
  message: Pick<Message, "id" | "raw">,
): string {
  if (message.raw && typeof message.raw === "object") {
    const ts = (message.raw as Record<string, unknown>).ts;
    if (typeof ts === "string" && ts.length > 0) {
      return ts;
    }
  }

  return message.id;
}
