import type { Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { StoredSlackActor } from "@/chat/actor";
import type { AgentTurnUsage } from "@/chat/usage";

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
  archivedAtMs?: number;
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: ConversationExecution;
  lastActivityAtMs: number;
  actor?: StoredSlackActor;
  schemaVersion: 1;
  source?: ConversationSource;
  title?: string;
  updatedAtMs: number;
  /**
   * When retention purged this conversation's content. Set means messages and
   * steps were deleted wholesale; reporting presents the transcript as expired
   * rather than privacy-redacted (`../../../../../policies/data-redaction.md`).
   */
  transcriptPurgedAtMs?: number;
  /** Persisted destination visibility. Undefined means no destination row exists. */
  visibility?: ConversationPrivacy;
}

/** Persist and read durable conversation metadata for reporting surfaces. */
export interface ConversationStore {
  get(args: { conversationId: string }): Promise<Conversation | undefined>;
  /** Read persisted visibility for one destination. Missing rows fail closed. */
  getDestinationVisibility(args: {
    provider: string;
    providerDestinationId: string;
    providerTenantId?: string;
  }): Promise<ConversationPrivacy | undefined>;
  recordActivity(args: {
    activityAtMs?: number;
    channelName?: string;
    conversationId: string;
    destination?: Destination;
    nowMs?: number;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    title?: string;
    /** Source-confirmed visibility from the current event's signal only. */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  /**
   * Establish a subagent child conversation row linked to its parent.
   *
   * Subagent histories live under their own child `conversation_id` with
   * `parent_conversation_id` set; the child carries no destination and is
   * excluded from top-level listings. Idempotent: it links a bare row a step
   * append may have created first without clobbering it.
   */
  ensureChildConversation(args: {
    conversationId: string;
    parentConversationId: string;
    nowMs?: number;
  }): Promise<void>;
  /** Store task-execution metadata for long-term conversation history. */
  recordExecution(args: {
    channelName?: string;
    conversationId: string;
    createdAtMs: number;
    destination?: Destination;
    execution: ConversationExecution;
    lastActivityAtMs: number;
    metrics: {
      durationMs: number;
      usage?: AgentTurnUsage;
    } | null;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
    /** Source-confirmed visibility from the current event's signal only. */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  listByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
