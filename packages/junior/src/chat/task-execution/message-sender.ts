import * as z from "zod";

/**
 * The Conversation and Turn that sent one inbound message, such as a child's
 * reply to its parent. The sender writes it at `input.metadata.sender`, so
 * readers never take meaning from the message id. `agentInvocationId` names
 * the Agent invocation that the message comes from, when there is one.
 */
export const inboundMessageSenderSchema = z
  .object({
    agentInvocationId: z.string().min(1).optional(),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .strict();

export type InboundMessageSender = z.output<typeof inboundMessageSenderSchema>;

/** Sender fields of each inbound message id that has them. */
export type InboundMessageSenders = Record<string, InboundMessageSender>;

/** Read the sender fields that one inbound message stores, if any. */
export function readInboundMessageSender(message: {
  input: { metadata?: Record<string, unknown> | undefined };
}): InboundMessageSender | undefined {
  const parsed = inboundMessageSenderSchema.safeParse(
    message.input.metadata?.["sender"],
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Keep the sender fields of `messages` next to their ids, so a reader still
 * has them after the mailbox drops the message itself.
 */
export function withMessageSenders(
  senders: InboundMessageSenders | undefined,
  messages: readonly {
    inboundMessageId: string;
    input: { metadata?: Record<string, unknown> | undefined };
  }[],
): InboundMessageSenders | undefined {
  let next = senders;
  for (const message of messages) {
    const sender = readInboundMessageSender(message);
    if (sender && !next?.[message.inboundMessageId]) {
      next = { ...next, [message.inboundMessageId]: sender };
    }
  }
  return next;
}

/** Decode stored sender fields. Invalid entries are dropped. */
export function normalizeMessageSenders(
  value: unknown,
): InboundMessageSenders | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const senders: InboundMessageSenders = {};
  for (const [id, raw] of Object.entries(value)) {
    const parsed = inboundMessageSenderSchema.safeParse(raw);
    if (parsed.success) senders[id] = parsed.data;
  }
  return Object.keys(senders).length ? senders : undefined;
}
