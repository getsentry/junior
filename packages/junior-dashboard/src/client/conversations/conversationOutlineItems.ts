import { displayPlainText } from "../display-text/plainText";
import type { TranscriptViewMessage } from "../types";

/** One person message in the outline, with Junior's reply to it. */
export type ConversationOutlineItem = {
  /** Event seq of the message. Its transcript row carries the same seq. */
  seq: number;
  title: string;
  /** The last Junior text before the next outline item. */
  reply?: string;
};

/**
 * List the messages that a person sent, in seq order, for the outline. Events
 * and context messages show as rail rows in the transcript, not as chat, so
 * they are not items.
 */
export function conversationOutlineItems(
  messages: readonly TranscriptViewMessage[],
): ConversationOutlineItem[] {
  const items: ConversationOutlineItem[] = [];
  for (const message of messages) {
    if (message.pending) continue;
    const text = displayPlainText(messageText(message), message.mentions);
    if (!text) continue;
    if (message.role === "user" && !message.eventType && !message.context) {
      items.push({ seq: message.sourceSeq, title: text });
    } else if (message.role === "assistant" && items.length > 0) {
      items.at(-1)!.reply = text;
    }
  }
  return items;
}

function messageText(message: TranscriptViewMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

/**
 * Find the item whose section holds `rowSeq`: the last item at or before it.
 * Items are in seq order.
 */
export function outlineItemAtSeq(
  items: readonly ConversationOutlineItem[],
  rowSeq: number,
): ConversationOutlineItem | undefined {
  let found: ConversationOutlineItem | undefined;
  for (const item of items) {
    if (item.seq > rowSeq) break;
    found = item;
  }
  return found;
}
