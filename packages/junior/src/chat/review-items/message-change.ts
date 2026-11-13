import type { Message } from "chat";
import type { ReviewItemChangeRecord } from "./change-record";

// A Slack Turn passes Chat SDK messages, not mailbox input. Like the author
// Identity id, the record rides next to the message until the Message write.
const messageChangeRecords = new WeakMap<Message, ReviewItemChangeRecord>();

/** Keep the record of a restored Slack input for its Message write. */
export function bindMessageReviewItemChange(
  message: Message,
  record: ReviewItemChangeRecord | undefined,
): void {
  if (record) messageChangeRecords.set(message, record);
}

/** Read the record that a restored Slack input carries. */
export function getMessageReviewItemChange(
  message: Message,
): ReviewItemChangeRecord | undefined {
  return messageChangeRecords.get(message);
}
