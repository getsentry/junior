import type { Message, SerializedMessage, SerializedThread, Thread } from "chat";

export type ThreadMessageKind = "new_mention" | "subscribed_message" | "subscribed_reply";

export interface QueueResumeContext {
  dedupKey: string;
  message: Message | SerializedMessage;
  normalizedThreadId: string;
  thread: Thread | SerializedThread;
}

export interface ThreadMessagePayload {
  dedupKey: string;
  kind: ThreadMessageKind;
  message: Message | SerializedMessage;
  normalizedThreadId: string;
  thread: Thread | SerializedThread;
  queueMessageId?: string;
}

export interface SubagentTaskPayload {
  callKey: string;
  conversationId: string;
  sessionId: string;
  task: string;
  queueContext: QueueResumeContext;
}

export type QueuePayload = ThreadMessagePayload | SubagentTaskPayload;
