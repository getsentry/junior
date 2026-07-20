/**
 * Durable conversation event history port.
 *
 * Events append under the conversation lease in stable sequence order. Context
 * rebuilds (compaction, handoff, rollback) open a new context epoch instead of
 * rewriting history. Unknown event types or malformed shapes fail loudly;
 * provider-specific message fields are validated by the Pi adapter when it
 * restores model context.
 */
import { z } from "zod";
import type { ConversationCompaction } from "@/chat/state/conversation";
import { modelProfileSchema } from "@/chat/model-profile";
import { conversationMessageProvenanceSchema } from "./provenance";

const handoffModelProfileSchema = modelProfileSchema.refine(
  (profile) => profile !== "standard",
  "handoff profile must not be standard",
);

/** Store a model message while leaving provider-specific validation to Pi. */
export const conversationModelMessageSchema = z
  .object({ role: z.string() })
  .passthrough()
  .transform((value) => value as { role: string });

/** A model message stored in the conversation event log. */
export type ConversationModelMessage = z.output<
  typeof conversationModelMessageSchema
>;

const conversationMessageDataSchema = z
  .object({
    message: conversationModelMessageSchema,
    provenance: conversationMessageProvenanceSchema.optional(),
  })
  .strict();

const messageEventDataSchema = conversationMessageDataSchema.extend({
  type: z.literal("message"),
});

const contextEpochMessageSchema = conversationMessageDataSchema.extend({
  createdAtMs: z.number().finite(),
});

const replacementHistoryMessageSchema = conversationMessageDataSchema.extend({
  // Preserve the copied message's position when a turn resumes. Synthetic
  // summary and handoff messages have no source event.
  sourceEventSeq: z.number().int().nonnegative().optional(),
});

/**
 * The complete message list used immediately after a context reset. Later
 * `message` events append to it. These entries are replayed model input, not
 * new conversation activity.
 */
const replacementHistorySchema = z.array(replacementHistoryMessageSchema);

const contextEpochStartedEventDataSchema = z.discriminatedUnion("reason", [
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.literal("initial"),
      modelProfile: z.literal("standard"),
      modelId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.literal("handoff"),
      modelProfile: handoffModelProfileSchema,
      modelId: z.string().min(1),
      triggeringToolCallId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.literal("compaction"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.literal("rollback"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
]);

/**
 * Validate a context reset. Initial `messages` are new events. On rollback,
 * `replacementHistory` replays the unchanged prefix and `messages` contains
 * only the newly generated suffix.
 */
export const contextEpochStartSchema = z.discriminatedUnion("reason", [
  z
    .object({
      reason: z.literal("initial"),
      modelProfile: z.literal("standard"),
      modelId: z.string().min(1),
      messages: z.array(contextEpochMessageSchema),
    })
    .strict(),
  z
    .object({
      reason: z.literal("handoff"),
      modelProfile: handoffModelProfileSchema,
      modelId: z.string().min(1),
      triggeringToolCallId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
  z
    .object({
      reason: z.literal("compaction"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
    })
    .strict(),
  z
    .object({
      reason: z.literal("rollback"),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      replacementHistory: replacementHistorySchema,
      messages: z.array(contextEpochMessageSchema),
    })
    .strict(),
]);

/** One atomically persisted context epoch and its model binding. */
export type ContextEpochStart = z.output<typeof contextEpochStartSchema>;

const mcpProviderConnectedEventDataSchema = z
  .object({
    type: z.literal("mcp_provider_connected"),
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

const visibleMessageRoleSchema = z.union([
  z.literal("user"),
  z.literal("assistant"),
  z.literal("system"),
]);

const visibleMessageRecordedEventDataSchema = z
  .object({
    type: z.literal("visible_message_recorded"),
    messageId: z.string().min(1),
    role: visibleMessageRoleSchema,
    text: z.string(),
    authorIdentityId: z.string().min(1).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const visibleMessageMetadataUpdatedEventDataSchema = z
  .object({
    type: z.literal("visible_message_metadata_updated"),
    messageId: z.string().min(1),
    meta: z.record(z.string(), z.unknown()),
  })
  .strict();

const visibleMessageRepliedEventDataSchema = z
  .object({
    type: z.literal("visible_message_replied"),
    messageId: z.string().min(1),
  })
  .strict();

const visibleContextCompactedEventDataSchema = z
  .object({
    type: z.literal("visible_context_compacted"),
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

const turnCompletedEventDataSchema = z
  .object({
    type: z.literal("turn_completed"),
    turnId: z.string().min(1),
    outcome: z.enum(["success", "no_reply"]),
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

/** Prevent ordinary appends from bypassing context-epoch lifecycle validation. */
const appendableConversationEventDataSchema = z.union([
  messageEventDataSchema,
  mcpProviderConnectedEventDataSchema,
  authorizationRequestedEventDataSchema,
  authorizationCompletedEventDataSchema,
  toolExecutionStartedEventDataSchema,
  visibleMessageRecordedEventDataSchema,
  visibleMessageMetadataUpdatedEventDataSchema,
  visibleMessageRepliedEventDataSchema,
  visibleContextCompactedEventDataSchema,
  turnStartedEventDataSchema,
  turnCompletedEventDataSchema,
  turnFailedEventDataSchema,
  subagentStartedEventDataSchema,
  subagentEndedEventDataSchema,
]);

/** Strict event-data contract reused by the SQL row codec. */
export const conversationEventDataSchema = z.union([
  appendableConversationEventDataSchema,
  contextEpochStartedEventDataSchema,
]);

/** One durable conversation event's validated data. */
export type ConversationEventData = z.output<
  typeof conversationEventDataSchema
>;

/**
 * Canonical ordered envelope for the durable conversation log.
 * `schemaVersion` is persisted with every physical event row.
 */
export const conversationEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: z.number().int().nonnegative(),
    contextEpoch: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).optional(),
    createdAtMs: z.number().finite(),
    data: conversationEventDataSchema,
  })
  .strict();

/** One versioned event read from the durable conversation log. */
export type ConversationEvent = z.output<typeof conversationEventSchema>;

/** Validate a current-epoch append without permitting epoch markers. */
export const newConversationEventSchema = z
  .object({
    data: appendableConversationEventDataSchema,
    idempotencyKey: z.string().min(1).optional(),
    createdAtMs: z.number().finite(),
  })
  .strict();

/** An event to append; the store assigns `seq` and the current context epoch. */
export type NewConversationEvent = z.output<typeof newConversationEventSchema>;

/** A new message written while opening a context epoch. */
export type ContextEpochMessage = z.output<typeof contextEpochMessageSchema>;

/** Persist and read the canonical per-conversation event log. */
export interface ConversationEventStore {
  /** Append events atomically, assigning `seq = max+1` under the lease. */
  append(conversationId: string, events: NewConversationEvent[]): Promise<void>;
  /**
   * Open initial epoch 0 or the next replacement epoch in one transaction.
   */
  startEpoch(conversationId: string, opts: ContextEpochStart): Promise<void>;
  /** Events of the highest epoch in `seq` order (all types; caller filters). */
  loadCurrentEpoch(conversationId: string): Promise<ConversationEvent[]>;
  /** Events in the epoch containing `seq`, or undefined when it is absent. */
  loadEpochContaining(
    conversationId: string,
    seq: number,
    throughSeq?: number,
  ): Promise<ConversationEvent[] | undefined>;
  /** Live visible-message facts and their latest compaction snapshot. */
  loadVisibleHistory(conversationId: string): Promise<{
    events: ConversationEvent[];
    compaction: ConversationEvent | undefined;
  }>;
  /** All events across every epoch in `seq` order, for audit and reporting. */
  loadHistory(conversationId: string): Promise<ConversationEvent[]>;
}
