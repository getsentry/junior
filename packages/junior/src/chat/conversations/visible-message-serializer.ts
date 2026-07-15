import type { NewConversationMessage } from "./messages";
import type { ConversationMessage } from "@/chat/state/conversation";

/** Serialize one in-memory visible message into its event-backed write shape. */
export function toStoredConversationMessage(
  message: ConversationMessage,
): NewConversationMessage {
  const meta: Record<string, unknown> = {};
  if (message.author) {
    meta.author = message.author;
  }
  const { replied, ...restMeta } = message.meta ?? {};
  Object.assign(meta, restMeta);
  if (replied === false) {
    meta.replied = false;
  }
  return {
    messageId: message.id,
    role: message.role,
    text: message.text,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    createdAtMs: message.createdAtMs,
  };
}
