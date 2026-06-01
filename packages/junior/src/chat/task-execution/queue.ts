export interface ConversationQueueMessage {
  conversationId: string;
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
