/**
 * Durable conversation event history port.
 *
 * Events append under the conversation lease in stable sequence order.
 * Compaction replaces the active model history without rewriting prior
 * events. `sql/history.ts` implements it.
 */
import type {
  ConversationEvent,
  HistoryReplacement,
  KnownConversationEventType,
  NewConversationEvent,
} from "@/db/conversation-history/events";

/**
 * Result of a history replacement. `historyVersion` is the new version when
 * replaced, or the current version that did not match when in conflict.
 */
export type HistoryReplacementResult =
  | { status: "replaced"; historyVersion: number }
  | { status: "conflict"; historyVersion: number };

/** Projection-ready message events paired with their authoritative boundary. */
export interface MessageHistory {
  events: ConversationEvent[];
  historyFromSeq: number;
}

/** Bounded observational page over the durable conversation event log. */
export interface ConversationEventQuery {
  /** Exclusive lower bound on `seq`. */
  afterSeq?: number;
  /** Exclusive upper bound on `seq`. */
  beforeSeq?: number | undefined;
  /** Maximum events to return. */
  limit: number;
  /** Optional event-type filter. Empty/undefined returns every type. */
  types?: readonly KnownConversationEventType[];
}

/** One page of raw conversation events plus pagination hints. */
export interface ConversationEventPage {
  events: ConversationEvent[];
  /** True when at least one older event exists before the returned page. */
  hasOlder: boolean;
  /** True when at least one newer event exists after the returned page. */
  hasNewer: boolean;
}

/** Persist and read the canonical per-conversation event log. */
export interface ConversationEventStore {
  /**
   * Append events atomically and return each event's sequence and history version.
   * Archive clears only for human user activity, not every non-preserve write.
   */
  append(
    conversationId: string,
    events: NewConversationEvent[],
    options?: { activity?: "preserve" },
  ): Promise<Array<Pick<ConversationEvent, "seq" | "historyVersion">>>;
  /**
   * Replace active model history with a compaction event.
   * With `expectedHistoryVersion`, write nothing and return a conflict when
   * the current History version differs.
   */
  replaceHistory(
    conversationId: string,
    replacement: HistoryReplacement,
    options?: { expectedHistoryVersion?: number },
  ): Promise<HistoryReplacementResult>;
  /** One event selected by its retry-stable key across history versions. */
  loadByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<ConversationEvent | undefined>;
  /** Latest matching structured event across history versions. */
  loadLatestStructuredEvent(
    conversationId: string,
    namespace: string,
    name: string,
  ): Promise<ConversationEvent | undefined>;
  /** Latest durable instruction across history versions. */
  loadLatestInstruction(
    conversationId: string,
  ): Promise<ConversationEvent | undefined>;
  /** Current model-history version, or zero when no event exists. */
  loadCurrentHistoryVersion(conversationId: string): Promise<number>;
  /** Events of the current history version in `seq` order. */
  loadCurrentHistory(conversationId: string): Promise<ConversationEvent[]>;
  /** Events after `afterSeq` across history versions in `seq` order. */
  loadEventsAfter(
    conversationId: string,
    afterSeq: number,
  ): Promise<ConversationEvent[]>;
  /** Events in the history version containing `seq`, when it exists. */
  loadHistoryContaining(
    conversationId: string,
    seq: number,
    throughSeq?: number,
  ): Promise<ConversationEvent[] | undefined>;
  /** Projection-ready message suffix, summary snapshot, and readable boundary. */
  loadMessageHistory(conversationId: string): Promise<MessageHistory>;
  /** All events across every history version in `seq` order. */
  loadHistory(conversationId: string): Promise<ConversationEvent[]>;
  /** Events of one type across every history version in `seq` order. */
  loadEventsOfType(
    conversationId: string,
    type: KnownConversationEventType,
  ): Promise<ConversationEvent[]>;
  /**
   * Bounded raw event page for observational/debug reads.
   * Defaults to the newest matching events when neither bound is set.
   */
  query(
    conversationId: string,
    query: ConversationEventQuery,
  ): Promise<ConversationEventPage>;
}
