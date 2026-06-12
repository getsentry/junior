import type {
  Conversation,
  ConversationExecution,
} from "@/chat/task-execution/state";
import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackRequester } from "@/chat/requester";

/** Persist and read queryable conversation records for reporting surfaces. */
export interface ConversationStore {
  getConversation(args: {
    conversationId: string;
  }): Promise<Conversation | undefined>;
  recordConversationActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    requester?: StoredSlackRequester;
    source?: Conversation["source"];
    title?: string;
  }): Promise<void>;
  recordConversationStatus(args: {
    channelName?: string;
    conversationId: string;
    createdAtMs: number;
    destination?: Destination;
    execution: Pick<
      ConversationExecution,
      | "lastCheckpointAtMs"
      | "lastEnqueuedAtMs"
      | "runId"
      | "status"
      | "updatedAtMs"
    >;
    lastActivityAtMs: number;
    requester?: StoredSlackRequester;
    source?: Conversation["source"];
    title?: string;
    updatedAtMs: number;
  }): Promise<void>;
  listConversationsByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
