import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackRequester } from "@/chat/requester";

export type ConversationSource =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "scheduler"
  | "slack";

export type ConversationStatus =
  | "awaiting_resume"
  | "idle"
  | "pending"
  | "running";

export interface ConversationExecution {
  lastCheckpointAtMs?: number;
  lastEnqueuedAtMs?: number;
  runId?: string;
  status: ConversationStatus;
  updatedAtMs?: number;
}

export interface Conversation {
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: ConversationExecution;
  lastActivityAtMs: number;
  requester?: StoredSlackRequester;
  schemaVersion: 1;
  source?: ConversationSource;
  title?: string;
  updatedAtMs: number;
}

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
    source?: ConversationSource;
    title?: string;
  }): Promise<void>;
  recordConversationStatus(args: {
    channelName?: string;
    conversationId: string;
    createdAtMs: number;
    destination?: Destination;
    execution: ConversationExecution;
    lastActivityAtMs: number;
    requester?: StoredSlackRequester;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
  }): Promise<void>;
  listConversationsByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
