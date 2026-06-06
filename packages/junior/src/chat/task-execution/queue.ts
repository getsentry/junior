import type { Destination } from "@sentry/junior-plugin-api";

export interface ConversationQueueMessage {
  conversationId: string;
  destination: Destination;
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
