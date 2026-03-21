import type {
  Message,
  SerializedMessage,
  SerializedThread,
  Thread,
} from "chat";

export type ThreadMessageKind =
  | "new_mention"
  | "subscribed_message"
  | "subscribed_reply";

export interface PreApprovedSubscribedDecision {
  reason: string;
  shouldReply: boolean;
  shouldUnsubscribe?: boolean;
}

export interface ThreadMessagePayload {
  dedupKey: string;
  kind: ThreadMessageKind;
  message: Message | SerializedMessage;
  normalizedThreadId: string;
  preApprovedDecision?: PreApprovedSubscribedDecision;
  thread: Thread | SerializedThread;
  queueMessageId?: string;
}
