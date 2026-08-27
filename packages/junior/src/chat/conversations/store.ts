import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { Location } from "@/chat/conversations/location";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { StoredSlackActor } from "@/chat/actor";
import type { SessionSource } from "@/chat/source";
import type { AgentTurnUsage } from "@/chat/usage";

export type ConversationSource =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "resource_event"
  | "scheduler"
  | "slack"
  | "web";

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

/**
 * Durable Conversation owned by Junior.
 *
 * The final interface stores zero or one complete Location here. No Location
 * means the Conversation stays in Junior's API and UI. A Location names the
 * outside place where a provider can deliver the Conversation. Source may also
 * contain this Location so the agent can use it. Delivery contains it when
 * output may be sent there. Only Delivery allows output to be sent.
 *
 * `destination` and `sessionSource` temporarily duplicate parts of that model.
 * Their field TODOs state when each legacy copy can be removed.
 */
export interface Conversation {
  // TODO(dcramer): Move this provider label into Location after stored
  // Conversation reads no longer need the legacy destination projection.
  channelName?: string;
  conversationId: string;
  createdAtMs: number;
  // TODO(dcramer): Remove this legacy Conversation routing field after core
  // reads use Location and provider output uses Delivery.
  destination?: Destination;
  execution: ConversationExecution;
  executionMetrics?: {
    durationMs: number;
    runId?: string;
    usage?: AgentTurnUsage;
  };
  lastActivityAtMs: number;
  /** Immutable parent Conversation. */
  parentConversationId?: string;
  /** Optional provider coordinates associated with this Conversation. */
  location?: Location;
  // TODO(dcramer): Replace this creation-time Actor projection with the
  // stored creator Identity after creator identity writes are complete.
  actor?: StoredSlackActor;
  // TODO(dcramer): Keep schemaVersion inside the SQL decoder after callers
  // stop constructing stored Conversation values directly.
  schemaVersion: 1;
  // TODO(dcramer): Rename this creation Source after SQL origin fields become
  // the only stored authority. It is not the Source for the current Turn.
  source?: ConversationSource;
  /**
   * Structured inbound Source locator for this conversation session.
   * Session-stable (threaded Slack keeps threadTs; channel-level turns omit
   * it; never stores per-message ts). Set-once.
   */
  // TODO(dcramer): Remove this locator after every stored Conversation has a
  // complete Location and all readers use Location instead.
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
  /** Create one Conversation with an immutable parent. */
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
  /**
   * Resolve one Slack channel id from a known destination display name.
   *
   * Matches only destinations Junior already stored for this workspace. Exact
   * name match after stripping a leading `#`. Returns undefined when missing
   * or ambiguous. Does not scan Slack.
   */
  findSlackDestinationByName(args: {
    channelName: string;
    teamId: string;
  }): Promise<{ channelId: string; channelName?: string } | undefined>;
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
