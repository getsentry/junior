import { z } from "zod";

/** Validate the conversation work hint sent through Vercel Queue. */
export const conversationQueueMessageSchema = z
  .object({
    conversationId: z.string().trim().min(1),
  })
  .strict();

/** Conversation work hint accepted by the queue callback and worker. */
export type ConversationQueueMessage = z.output<
  typeof conversationQueueMessageSchema
>;

export type ConversationQueueMessageRejectReason =
  | "expired"
  | "invalid_record"
  | "malformed"
  | "signature_mismatch";

export class ConversationQueueMessageRejectedError extends Error {
  conversationId?: string;
  reason: ConversationQueueMessageRejectReason;

  constructor(
    reason: ConversationQueueMessageRejectReason,
    message: string,
    options: { conversationId?: string } = {},
  ) {
    super(message);
    this.name = "ConversationQueueMessageRejectedError";
    this.reason = reason;
    this.conversationId = options.conversationId;
  }
}

/** Return whether an error means the queue message was permanently rejected. */
export function isConversationQueueMessageRejectedError(
  error: unknown,
): error is ConversationQueueMessageRejectedError {
  return error instanceof ConversationQueueMessageRejectedError;
}

export interface ConversationQueueSendOptions {
  delayMs?: number;
  idempotencyKey?: string;
}

export interface ConversationQueueSendResult {
  messageId?: string;
}

/**
 * External transport for wake-up hints. Durable work stays in the mailbox;
 * transports only need to accept one hint and may return a provider message id.
 */
export interface ConversationWorkQueue {
  send(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): Promise<ConversationQueueSendResult | void>;
}
