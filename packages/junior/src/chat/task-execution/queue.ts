import type { Destination } from "@sentry/junior-plugin-api";

export interface ConversationQueueMessage {
  conversationId: string;
  destination: Destination;
}

export type ConversationQueueMessageRejectReason =
  | "destination_mismatch"
  | "expired"
  | "malformed"
  | "signature_mismatch"
  | "unauthorized";

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

/** Return whether a queue payload was permanently rejected at the message boundary. */
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

export interface ConversationWorkQueue {
  send(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): Promise<ConversationQueueSendResult | void>;
}
