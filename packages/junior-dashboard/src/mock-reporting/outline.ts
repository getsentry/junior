import {
  CONVERSATION_OUTLINE_TEXT_LENGTH,
  type ConversationOutline,
} from "@sentry/junior/api/schema";
import { readMockConversationAllEvents } from "./fixtures";

/**
 * List the person messages of a mock Conversation with their replies, like
 * the outline API.
 */
export function readMockConversationOutline(
  conversationId: string,
): ConversationOutline | undefined {
  const page = readMockConversationAllEvents(conversationId);
  if (!page) return undefined;
  if (page.eventHistory.status !== "available") return { items: [] };
  const items: ConversationOutline["items"] = [];
  for (const { createdAt, data, mentions, seq } of page.events) {
    if (data.type !== "message") continue;
    const text = data.text?.slice(0, CONVERSATION_OUTLINE_TEXT_LENGTH).trim();
    if (!text) continue;
    if (data.role === "assistant") {
      if (items.length > 0) items.at(-1)!.reply = text;
    } else if (
      data.role === "user" &&
      data.eventType === undefined &&
      data.explicitMention !== false
    ) {
      items.push({
        createdAt,
        seq,
        text,
        ...(mentions ? { mentions } : undefined),
      });
    }
  }
  return { items };
}
