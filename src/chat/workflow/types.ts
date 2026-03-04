import type { Message, SerializedMessage, SerializedThread, Thread } from "chat";

export type ThreadMessageKind = "new_mention" | "subscribed_message";

export interface ThreadMessagePayload {
  dedupKey: string;
  kind: ThreadMessageKind;
  message: Message | SerializedMessage;
  normalizedThreadId: string;
  thread: Thread | SerializedThread;
  workflowRunId?: string;
}
