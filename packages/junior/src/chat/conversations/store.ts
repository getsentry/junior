import type { Destination } from "@sentry/junior-plugin-api";
import type { StoredSlackRequester } from "@/chat/requester";

export type ConversationSource =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "resource_event"
  | "scheduler"
  | "slack";

export type ConversationStatus =
  | "awaiting_resume"
  | "failed"
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

/** Persist and read durable conversation metadata for reporting surfaces. */
export interface ConversationStore {
  get(args: { conversationId: string }): Promise<Conversation | undefined>;
  recordActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    requester?: StoredSlackRequester;
    source?: ConversationSource;
    title?: string;
  }): Promise<void>;
  /** Store task-execution metadata for long-term conversation history. */
  recordExecution(args: {
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
  listByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
