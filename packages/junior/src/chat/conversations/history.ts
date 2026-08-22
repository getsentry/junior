/**
 * Durable conversation event history port.
 *
 * Events append under the conversation lease in stable sequence order.
 * Compaction and handoff replace the active model history without rewriting
 * prior events. Unsupported stored events remain readable as opaque facts,
 * while malformed known events fail loudly. Provider-specific message fields
 * are validated by the Pi adapter when it restores model context.
 */
import { z } from "zod";
import type { ConversationCompaction } from "@/chat/state/conversation";
import { modelProfileSchema } from "@/chat/model-profile";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { conversationMessageProvenanceSchema } from "./provenance";

const userMessageEventDataSchema = z
  .object({
    type: z.literal("user_message"),
    role: z.never().optional(),
    provenance: conversationMessageProvenanceSchema,
  })
  .passthrough();

const assistantMessageEventDataSchema = z
  .object({
    type: z.literal("assistant_message"),
    role: z.never().optional(),
  })
  .passthrough();

const toolResultEventDataSchema = z
  .object({
    type: z.literal("tool_result"),
    role: z.never().optional(),
  })
  .passthrough();

/**
 * One replayable agent-history item. Junior owns `type` and user provenance,
 * forbids the provider `role` discriminator, and leaves preserved message
 * fields for the Pi adapter to validate when restoring model context.
 */
export const agentHistoryItemSchema = z.discriminatedUnion("type", [
  userMessageEventDataSchema,
  assistantMessageEventDataSchema,
  toolResultEventDataSchema,
]);

/** A native replayable agent-history item. */
export type AgentHistoryItem = z.output<typeof agentHistoryItemSchema>;

const nativeReplacementHistoryItemSchema = z
  .object({
    item: agentHistoryItemSchema,
    // Preserve the copied item's position when a turn resumes. Synthetic
    // summary and handoff items have no source event.
    sourceEventSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * The complete agent history used immediately after a replacement. Later
 * native history events append to it. Replacement entries are replayed model
 * history, not new conversation activity.
 */
const replacementHistorySchema = z.array(nativeReplacementHistoryItemSchema);

const compactionDetailsSchema = z
  .object({
    reason: z.literal("capacity"),
    estimatedInputTokens: z.number().int().nonnegative(),
    replacementInputTokens: z.number().int().nonnegative().optional(),
    triggerTokens: z.number().int().nonnegative(),
    inputLimitTokens: z.number().int().positive(),
    inputMessageCount: z.number().int().nonnegative(),
    retainedMessageCount: z.number().int().nonnegative(),
    summaryChars: z.number().int().nonnegative(),
  })
  .strict();

const historyReplacementEventDataSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("handoff"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      reasoningLevel: z.string().min(1).optional(),
      triggeringToolCallId: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("compaction"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      details: compactionDetailsSchema.optional(),
      summary: z.string().min(1).optional(),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
]);

/** Validate an event that intentionally replaces active model history. */
export const historyReplacementSchema = z
  .object({
    data: historyReplacementEventDataSchema,
    createdAtMs: z.number().finite(),
  })
  .strict();

/** One atomically persisted model-history replacement. */
export type HistoryReplacement = z.output<typeof historyReplacementSchema>;

const mcpProviderConnectedEventDataSchema = z
  .object({
    type: z.literal("mcp_provider_connected"),
    provider: z.string().min(1),
    credentialSubjectId: z.string().min(1),
  })
  .strict();

// Migration-only fact for connections recorded before credential ownership.
// Readers keep it replayable, but writers cannot append it and restore ignores it.
const unownedMcpProviderConnectedEventDataSchema = z
  .object({
    type: z.literal("mcp_provider_connected_unowned"),
    provider: z.string().min(1),
  })
  .strict();

export const authorizationKindSchema = z.union([
  z.literal("plugin"),
  z.literal("mcp"),
]);

/** Provider authorization family recorded by conversation events. */
export type AuthorizationKind = z.output<typeof authorizationKindSchema>;

const authorizationRequestedEventDataSchema = z
  .object({
    type: z.literal("authorization_requested"),
    kind: authorizationKindSchema,
    provider: z.string().min(1),
    actorId: z.string().min(1),
    authorizationId: z.string().min(1),
    delivery: z.union([
      z.literal("private_link_sent"),
      z.literal("private_link_reused"),
    ]),
  })
  .strict();

const authorizationCompletedEventDataSchema = z
  .object({
    type: z.literal("authorization_completed"),
    kind: authorizationKindSchema,
    provider: z.string().min(1),
    actorId: z.string().min(1),
    authorizationId: z.string().min(1),
  })
  .strict();

const toolExecutionStartedEventDataSchema = z
  .object({
    type: z.literal("tool_execution_started"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
  })
  .strict();

const guardianActionReviewedEventDataSchema = z
  .object({
    type: z.literal("guardian_action_reviewed"),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    costUsd: z.number().finite().nonnegative().optional(),
    decision: z.enum(["allow", "ask", "deny"]),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    userAuthorization: z.enum(["high", "medium", "low", "unknown"]),
  })
  .strict();

const conversationMessageRoleSchema = z.union([
  z.literal("user"),
  z.literal("assistant"),
  z.literal("system"),
]);

const messageEventDataSchema = z
  .object({
    type: z.literal("message"),
    messageId: z.string().min(1),
    role: conversationMessageRoleSchema,
    text: z.string(),
    authorIdentityId: z.string().min(1).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const messageUpdatedEventDataSchema = messageEventDataSchema.extend({
  type: z.literal("message_updated"),
});

const messageHandledEventDataSchema = z
  .object({
    type: z.literal("message_handled"),
    messageId: z.string().min(1),
  })
  .strict();

const messagesSummarizedEventDataSchema = z
  .object({
    type: z.literal("messages_summarized"),
    historyFromSeq: z.number().int().nonnegative(),
    compactions: z.array(
      z
        .object({
          coveredMessageCount: z.number().int().nonnegative(),
          createdAtMs: z.number(),
          id: z.string().min(1),
          summary: z.string(),
        })
        .strict(),
    ) satisfies z.ZodType<ConversationCompaction[]>,
  })
  .strict();

/** Product surface that owns a durable conversation turn. */
export const conversationTurnSurfaceSchema = z.enum([
  "slack",
  "api",
  "scheduler",
  "internal",
]);

/** Stable, privacy-safe classification for a failed turn. */
export const conversationTurnFailureCodeSchema = z.enum([
  "agent_run_failed",
  "delivery_failed",
  "model_execution_failed",
  "persistence_failed",
]);

/** Failure classification persisted without raw provider or exception data. */
export type ConversationTurnFailureCode = z.output<
  typeof conversationTurnFailureCodeSchema
>;

const turnStartedEventDataSchema = z
  .object({
    type: z.literal("turn_started"),
    turnId: z.string().min(1),
    inputMessageIds: z.array(z.string().min(1)).min(1),
    surface: conversationTurnSurfaceSchema,
  })
  .strict()
  .refine(
    (data) =>
      new Set(data.inputMessageIds).size === data.inputMessageIds.length,
    "turn input message ids must be unique",
  );

const turnRoutedEventDataSchema = z
  .object({
    type: z.literal("turn_routed"),
    turnId: z.string().min(1),
    modelProfile: modelProfileSchema,
    modelId: z.string().min(1),
    costUsd: z.number().finite().nonnegative().optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS),
    confidence: z.number().min(0).max(1).optional(),
    source: z.enum(["configured", "inherited", "router"]),
  })
  .strict();

const turnContextEventDataSchema = z
  .object({
    type: z.literal("turn_context"),
    turnId: z.string().min(1),
    pluginName: z.string().min(1),
    kind: z.string().min(1).max(64),
    version: z.number().int().positive(),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

const structuredConversationEventDataSchema = z
  .object({
    type: z.literal("structured_event"),
    namespace: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    version: z.number().int().positive(),
    turnId: z.string().min(1).optional(),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Durable attachment metadata on host-owned delivery events. */
const deliveredAttachmentSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Host-owned transcript item for files delivered to humans this turn. */
const attachmentsDeliveredEventDataSchema = z
  .object({
    type: z.literal("attachments_delivered"),
    attachments: z.array(deliveredAttachmentSchema).min(1),
    toolCallId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  })
  .strict();

const turnCompletedEventDataSchema = z
  .object({
    type: z.literal("turn_completed"),
    turnId: z.string().min(1),
    outcome: z.enum(["success", "no_reply", "cancelled"]),
  })
  .strict();

const turnFailedEventDataSchema = z
  .object({
    type: z.literal("turn_failed"),
    turnId: z.string().min(1),
    failureCode: conversationTurnFailureCodeSchema,
    eventId: z
      .string()
      .regex(/^[a-f0-9]{32}$/i)
      .optional(),
  })
  .strict();

// Subagent histories are child conversations; the marker references the child by
// its own conversation id rather than a polymorphic transcript locator.
const subagentStartedEventDataSchema = z
  .object({
    type: z.literal("subagent_started"),
    subagentInvocationId: z.string().min(1),
    subagentKind: z.string().min(1),
    modelId: z.string().min(1).optional(),
    parentToolCallId: z.string().min(1).optional(),
    reasoningLevel: z.string().min(1).optional(),
    childConversationId: z.string().min(1),
  })
  .strict();

const subagentEndedEventDataSchema = z
  .object({
    type: z.literal("subagent_ended"),
    subagentInvocationId: z.string().min(1),
    outcome: z.union([
      z.literal("success"),
      z.literal("error"),
      z.literal("aborted"),
    ]),
    errorCode: z.string().min(1).optional(),
  })
  .strict();

/** Prevent ordinary appends from bypassing history-replacement validation. */
const appendableConversationEventDataSchema = z.union([
  messageEventDataSchema,
  messageUpdatedEventDataSchema,
  agentHistoryItemSchema,
  mcpProviderConnectedEventDataSchema,
  authorizationRequestedEventDataSchema,
  authorizationCompletedEventDataSchema,
  toolExecutionStartedEventDataSchema,
  guardianActionReviewedEventDataSchema,
  messageHandledEventDataSchema,
  messagesSummarizedEventDataSchema,
  turnStartedEventDataSchema,
  turnContextEventDataSchema,
  structuredConversationEventDataSchema,
  attachmentsDeliveredEventDataSchema,
  turnRoutedEventDataSchema,
  turnCompletedEventDataSchema,
  turnFailedEventDataSchema,
  subagentStartedEventDataSchema,
  subagentEndedEventDataSchema,
]);

/** Strict event-data contract reused by the SQL row codec. */
export const conversationEventDataSchema = z.union([
  appendableConversationEventDataSchema,
  historyReplacementEventDataSchema,
  unownedMcpProviderConnectedEventDataSchema,
]);

/** One durable conversation event's validated data. */
export type ConversationEventData = z.output<
  typeof conversationEventDataSchema
>;

// This list distinguishes unsupported rows from corrupt known rows. Add every
// canonical event type here with its data schema.
/** Event type names recognized by current readers and observational queries. */
export const KNOWN_CONVERSATION_EVENT_TYPES = [
  "message",
  "message_updated",
  "user_message",
  "assistant_message",
  "tool_result",
  "mcp_provider_connected",
  "mcp_provider_connected_unowned",
  "authorization_requested",
  "authorization_completed",
  "tool_execution_started",
  "guardian_action_reviewed",
  "message_handled",
  "messages_summarized",
  "turn_started",
  "turn_context",
  "structured_event",
  "attachments_delivered",
  "turn_routed",
  "turn_completed",
  "turn_failed",
  "subagent_started",
  "subagent_ended",
  "handoff",
  "compaction",
] as const;

/** One known durable conversation event type name. */
export type KnownConversationEventType =
  (typeof KNOWN_CONVERSATION_EVENT_TYPES)[number];

const knownConversationEventTypeSchema = z.enum(KNOWN_CONVERSATION_EVENT_TYPES);

const unknownConversationEventDataSchema = z
  .object({
    type: z.literal("unknown"),
    originalType: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

/** Opaque data from a stored event this Junior version cannot interpret. */
export type UnknownConversationEventData = z.output<
  typeof unknownConversationEventDataSchema
>;

const conversationEventEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    historyVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).optional(),
    createdAtMs: z.number().finite(),
  })
  .strict();

/**
 * Canonical ordered envelope for the durable conversation log.
 * `schemaVersion` is persisted with every physical event row.
 */
export const conversationEventSchema = z.union([
  conversationEventEnvelopeSchema.extend({
    schemaVersion: z.literal(1),
    data: conversationEventDataSchema,
  }),
  conversationEventEnvelopeSchema.extend({
    data: unknownConversationEventDataSchema,
  }),
]);

/** One versioned event read from the durable conversation log. */
export type ConversationEvent = z.output<typeof conversationEventSchema>;

/** A decoded message-summary event and its readable history boundary. */
export type MessagesSummarizedEvent = Omit<
  Extract<ConversationEvent, { schemaVersion: 1 }>,
  "data"
> & {
  data: Extract<ConversationEventData, { type: "messages_summarized" }>;
};

/** Projection-ready message events paired with their authoritative boundary. */
export interface MessageHistory {
  events: ConversationEvent[];
  compaction: MessagesSummarizedEvent | undefined;
  historyFromSeq: number;
}

const storedConversationEventSchema = conversationEventEnvelopeSchema.extend({
  type: z.string().min(1),
  payload: z.unknown(),
});

/**
 * Decode a physical event row without making old or future event types
 * unreadable. Unsupported rows stay opaque until an upgrade migration defines
 * their semantics; known version-one events remain strict so corrupt canonical
 * data cannot be mistaken for compatibility data.
 */
export function decodeStoredConversationEvent(
  value: z.input<typeof storedConversationEventSchema>,
): ConversationEvent {
  const stored = storedConversationEventSchema.parse(value);
  const { type, payload, ...envelope } = stored;
  const knownType = knownConversationEventTypeSchema.safeParse(type).success;
  if (stored.schemaVersion === 1 && knownType) {
    const data =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? { ...payload, type }
        : { type };
    return conversationEventSchema.parse({ ...envelope, data });
  }
  return conversationEventSchema.parse({
    ...envelope,
    data: { type: "unknown", originalType: type, payload },
  });
}

/** Validate an append without permitting model-history replacement events. */
export const newConversationEventSchema = z
  .object({
    data: appendableConversationEventDataSchema,
    idempotencyKey: z.string().min(1).optional(),
    createdAtMs: z.number().finite(),
  })
  .strict();

/** An event to append; the store assigns `seq` and current history version. */
export type NewConversationEvent = z.output<typeof newConversationEventSchema>;

/** Bounded observational page over the durable conversation event log. */
export interface ConversationEventQuery {
  /** Exclusive lower bound on `seq`. */
  afterSeq?: number;
  /** Exclusive upper bound on `seq`. */
  beforeSeq?: number;
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
   * Append events atomically, optionally preserving conversation activity.
   * Archive clears only for human user activity, not every non-preserve write.
   */
  append(
    conversationId: string,
    events: NewConversationEvent[],
    options?: { activity?: "preserve" },
  ): Promise<void>;
  /** Replace active model history with a compaction or handoff event. */
  replaceHistory(
    conversationId: string,
    replacement: HistoryReplacement,
  ): Promise<void>;
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
  /** Events of the current history version in `seq` order. */
  loadCurrentHistory(conversationId: string): Promise<ConversationEvent[]>;
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
  /**
   * Bounded raw event page for observational/debug reads.
   * Defaults to the newest matching events when neither bound is set.
   */
  query(
    conversationId: string,
    query: ConversationEventQuery,
  ): Promise<ConversationEventPage>;
}
