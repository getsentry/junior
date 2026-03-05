import type { Message, SerializedMessage, SerializedThread, Thread } from "chat";

export type ThreadMessageKind = "new_mention" | "subscribed_message" | "subscribed_reply";

export interface ThreadMessagePayload {
  dedupKey: string;
  kind: ThreadMessageKind;
  message: Message | SerializedMessage;
  normalizedThreadId: string;
  thread: Thread | SerializedThread;
  queueMessageId?: string;
}
