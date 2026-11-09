import {
  CONVERSATION_OUTLINE_TEXT_LENGTH,
  type ConversationOutline,
} from "@sentry/junior/api/schema";
import { readMockConversationAllEvents } from "./fixtures";

/** List the person messages of a mock Conversation, like the outline API. */
export function readMockConversationOutline(
  conversationId: string,
): ConversationOutline | undefined {
  const page = readMockConversationAllEvents(conversationId);
  if (!page) return undefined;
  if (page.eventHistory.status !== "available") return { items: [] };
  return {
    items: page.events.flatMap(({ data, mentions, seq }) => {
      if (
        data.type !== "message" ||
        data.role !== "user" ||
        data.eventType !== undefined ||
        data.explicitMention === false
      ) {
        return [];
      }
      const text = data.text?.slice(0, CONVERSATION_OUTLINE_TEXT_LENGTH).trim();
      return text
        ? [{ seq, text, ...(mentions ? { mentions } : undefined) }]
        : [];
    }),
  };
}
