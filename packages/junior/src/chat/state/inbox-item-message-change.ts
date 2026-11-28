import type { Message } from "chat";
import type { InboxItemChangeRecord } from "./inbox-item-change-record";

// A Slack Turn passes Chat SDK messages, not mailbox input. Like the author
// Identity id, the record rides next to the message until the Message write.
const messageChangeRecords = new WeakMap<Message, InboxItemChangeRecord>();

/** Keep the record of a restored Slack input for its Message write. */
export function bindMessageInboxItemChange(
  message: Message,
  record: InboxItemChangeRecord | undefined,
): void {
  if (record) messageChangeRecords.set(message, record);
}

/** Read the record that a restored Slack input carries. */
export function getMessageInboxItemChange(
  message: Message,
): InboxItemChangeRecord | undefined {
  return messageChangeRecords.get(message);
}
