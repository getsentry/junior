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
  | "event"
  | "scheduler"
  | "slack"
  | "web";

/**
 * Where a Conversation sits in its tree. A root and an Automation run have no
 * parent. A Thread is a child that people can message. A Task is a child that
 * only its parent messages. A Conversation never changes kind.
 */
export type ConversationKind = "root" | "automation" | "thread" | "task";

/** The kind of a Conversation that has a parent. */
export type ChildConversationKind = "thread" | "task";

export type ConversationStatus =
  | "paused"
  | "failed"
  | "idle"
  | "pending"
  | "running";

/** Cumulative duration and usage that one Run reported. */
export interface ConversationRunMetrics {
  durationMs: number;
  usage?: AgentTurnUsage;
}

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
 * outside place where a provider can deliver the Conversation. A Run carries
 * this Location when the agent or tools need it. Source stays about the input.
 * Delivery is created for the Location and allows output to be sent there.
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
  /** Metrics of the latest Run that wrote metrics. */
  executionMetrics?: ConversationRunMetrics & { runId?: string };
  /** Immutable kind. Set when the Conversation is created. */
  kind: ConversationKind;
  lastActivityAtMs: number;
  /** Immutable parent Conversation. */
  parentConversationId?: string;
  /**
   * When the Conversation was archived for everyone. Only archive, auto-archive,
   * pin, and a person's message write it; `upsertConversation` does not.
   */
  archivedAtMs?: number;
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
  // TODO(dcramer): Remove sessionSource after resume reads the saved Turn Source
  // and all Conversation place readers use Location.
  sessionSource?: SessionSource;
  title?: string;
  updatedAtMs: number;
  /**
   * When retention purged this conversation's content. Set means messages and
   * events were deleted wholesale; reporting presents the transcript as expired
   * rather than privacy-redacted (`../../../../../policies/data-redaction.md`).
   */
  transcriptPurgedAtMs?: number;
  /** When a person stopped this Conversation. Unset when it is not stopped. */
  stoppedAtMs?: number;
  /** Set while a root's Event Turn replies stay out of its Location. */
  deliveryPausedAtMs?: number;
  /** Confirmed Conversation visibility. Undefined means no confirmation exists. */
  visibility?: ConversationPrivacy;
}

/** Persist and read durable conversation metadata for reporting surfaces. */
export interface ConversationStore {
  /**
   * Create one Conversation with an immutable parent and kind. `title` is
   * saved only when the child is new.
   */
  createChild(args: {
    childConversationId: string;
    kind: ChildConversationKind;
    parentConversationId: string;
    nowMs?: number;
    source?: ConversationSource;
    title?: string;
  }): Promise<void>;
  get(args: { conversationId: string }): Promise<Conversation | undefined>;
  /** Read one Run's stored metrics, including a Run that is not the latest. */
  getRunMetrics(args: {
    conversationId: string;
    runId: string;
  }): Promise<ConversationRunMetrics | undefined>;
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
   * Store live visibility for a Destination that has no Conversation yet,
   * such as a channel that an Automation moves to.
   */
  recordDestinationVisibility(args: {
    channelName?: string;
    destination: Destination;
    nowMs?: number;
    visibility: ConversationPrivacy;
  }): Promise<void>;
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
    /**
     * Current visibility from its owner, such as a Slack event channel type. It
     * replaces the visibility of the shared Destination row. Omit it for saved
     * values, such as visibility captured when an Automation was created.
     */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  /**
   * Store execution state and one Run's metrics.
   * Conversation metric fields cache totals for existing readers.
   */
  recordExecution(args: {
    /** Identity of the Turn Actor. Its metric rows record it. */
    actorIdentityId?: string;
    channelName?: string;
    conversationId: string;
    /** When this Run started. */
    createdAtMs: number;
    destination?: Destination;
    execution: ConversationExecution;
    lastActivityAtMs: number;
    metrics: ConversationRunMetrics | null;
    actor?: StoredSlackActor;
    source?: ConversationSource;
    title?: string;
    updatedAtMs: number;
    /**
     * Current visibility from its owner, such as a Slack event channel type. It
     * replaces the visibility of the shared Destination row. Omit it for saved
     * values, such as visibility captured when an Automation was created.
     */
    visibility?: ConversationPrivacy;
  }): Promise<void>;
  listByActivity(args?: {
    limit?: number;
    offset?: number;
  }): Promise<Conversation[]>;
}
