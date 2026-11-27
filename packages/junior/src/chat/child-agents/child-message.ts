import type {
  InboundMessageSender,
  InboundMessageSenders,
} from "@/chat/task-execution/message-sender";

/**
 * One reply or result that a child agent sent to its parent, read from the
 * sender fields that the message stores. The message id is only its
 * idempotency key.
 */
export type ChildMessage = {
  inboundMessageId: string;
  sender: InboundMessageSender;
};

/**
 * List the child replies and results among the ids that reached one
 * mailbox, oldest first, with the sender fields that the mailbox keeps.
 */
export function listChildMessages(
  inboundMessageIds: readonly string[],
  messageSenders: Readonly<InboundMessageSenders>,
): ChildMessage[] {
  return inboundMessageIds.flatMap((inboundMessageId) => {
    const sender = messageSenders[inboundMessageId];
    return sender ? [{ inboundMessageId, sender }] : [];
  });
}
