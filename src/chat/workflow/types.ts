import type { Message, Thread } from "chat";

export type ThreadMessageKind = "new_mention" | "subscribed_message";

export interface ThreadMessagePayload {
  dedupKey: string;
  kind: ThreadMessageKind;
  message: Message;
  normalizedThreadId: string;
  thread: Thread;
  workflowRunId?: string;
}
