import { stringifyMarkdown, type Message } from "chat";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

/**
 * Preserve the native Slack message timestamp when a synthetic message ID is
 * used for routing or deduplication.
 */
export function getSlackMessageTs(
  message: Pick<Message, "id" | "raw">,
): SlackMessageTs | undefined {
  const idTs = parseSlackMessageTs(message.id);
  if (idTs) {
    return idTs;
  }

  if (message.raw && typeof message.raw === "object") {
    return parseSlackMessageTs((message.raw as Record<string, unknown>).ts);
  }

  return undefined;
}

/**
 * Return the Chat SDK's canonical formatted representation by default.
 * Fall back to plain text when formatted content is missing or empty.
 *
 * Some ingress/test paths only materialize plain `text` (for example eval
 * ready-queue deliveries and partially hydrated messages), so `formatted`
 * cannot be assumed present even though the Chat SDK Message type marks it
 * required on fully constructed instances.
 */
export function getSlackMessageText(
  message: {
    formatted?: Message["formatted"] | null;
    text: string;
  },
): string {
  const formatted = message.formatted;
  if (formatted && formatted.children.length > 0) {
    return stringifyMarkdown(formatted).trim();
  }
  return message.text.trim();
}
