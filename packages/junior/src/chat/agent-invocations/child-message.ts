import * as z from "zod";
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

/** Mailbox metadata that stores who sent one child reply or result. */
export function childMessageSenderMetadata(sender: InboundMessageSender): {
  sender: InboundMessageSender;
} {
  return { sender };
}

const childResultSchema = z.object({
  status: z.enum(["blocked", "completed", "failed", "stopped"]),
});

/** How the child's work that a result reports ended. */
export type ChildResultStatus = z.output<typeof childResultSchema>["status"];

/**
 * Mailbox metadata that marks a child message as its result and stores how
 * the work ended. A message that a child sends while it still works has none.
 */
export function childResultMetadata(status: ChildResultStatus): {
  result: { status: ChildResultStatus };
} {
  return { result: { status } };
}

/** Read how the child's work ended, when the message is its result. */
export function readChildResultStatus(message: {
  input: { metadata?: Record<string, unknown> | undefined };
}): ChildResultStatus | undefined {
  const parsed = childResultSchema.safeParse(
    message.input.metadata?.["result"],
  );
  return parsed.success ? parsed.data.status : undefined;
}

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
