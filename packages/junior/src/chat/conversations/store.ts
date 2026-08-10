import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { StoredSlackActor } from "@/chat/actor";
import type { Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";
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
  | "paused"
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

/** Immutable parent correlation for a child conversation. */
export interface ConversationLineage {
  parentConversationId: string;
}

export interface Conversation {
  archivedAtMs?: number;
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  destination?: Destination;
  execution: ConversationExecution;
  executionMetrics?: {
    durationMs: number;
    runId?: string;
    usage?: AgentTurnUsage;
  };
  lastActivityAtMs: number;
  lineage?: ConversationLineage;
  location?: Location;
  actor?: StoredSlackActor;
  schemaVersion: 1;
  source?: ConversationSource;
  /**
   * Structured inbound Source locator for this conversation session.
   * Session-stable (threaded Slack keeps threadTs; channel-level turns omit
   * it; never stores per-message ts). Set-once.
   */
  sessionSource?: SessionSource;
  title?: string;
  updatedAtMs: number;
  /**
   * When retention purged this conversation's content. Set means messages and
   * events were deleted wholesale; reporting presents the transcript as expired
   * rather than privacy-redacted (`../../../../../policies/data-redaction.md`).
   */
  transcriptPurgedAtMs?: number;
  /** Persisted destination visibility. Undefined means no destination row exists. */
  visibility?: ConversationPrivacy;
}

/** Persist and read durable conversation metadata for reporting surfaces. */
export interface ConversationStore {
  /** Create one destinationless child with immutable parent lineage. */
  createChild(args: {
    childConversationId: string;
    parentConversationId: string;
    nowMs?: number;
    source?: ConversationSource;
  }): Promise<void>;
  get(args: { conversationId: string }): Promise<Conversation | undefined>;
  /** Resolve the durable conversation bound to one provider conversation. */
  getConversationIdByProviderConversation(args: {
    provider: string;
    providerDestinationId: string;
    providerTenantId: string;
    providerConversationId: string;
  }): Promise<string | undefined>;
  /** Bind one provider conversation to its pre-existing durable conversation. */
  bindProviderConversation(args: {
    conversationId: string;
    provider: string;
    providerDestinationId: string;
    providerTenantId: string;
    providerConversationId: string;
  }): Promise<void>;
  /** Read confirmed public/private visibility for one destination. */
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
    /** Source normalized to a stable session locator; set-once when absent. */
    sessionSource?: Source;
    title?: string;
    /** Confirmed destination visibility; omit when unavailable. */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  /**
   * Materialize execution and usage aggregates beside canonical metadata.
   * These fields serve reporting and runtime control, never history hydration.
   */
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
    /** Confirmed destination visibility; omit when unavailable. */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  listByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
