/**
 * Durable conversation event history port.
 *
 * Events append under the conversation lease in stable sequence order. Context
 * rebuilds (compaction, handoff, rollback) open a new context epoch instead of
 * rewriting history. Unknown event types or malformed shapes fail loudly;
 * nested model-message fields remain opaque continuity data and are interpreted
 * only by the Pi adapter.
 */
import { z } from "zod";
import type { ConversationCompaction } from "@/chat/state/conversation";
import { modelProfileSchema } from "@/chat/model-profile";
import { conversationMessageProvenanceSchema } from "./provenance";

const handoffModelProfileSchema = modelProfileSchema.refine(
  (profile) => profile !== "standard",
  "handoff profile must not be standard",
);

/** Junior-owned durable message shape; Pi-specific validation belongs to its adapter. */
export const conversationModelMessageSchema = z
  .object({ role: z.string() })
  .passthrough()
  .transform((value) => value as { role: string });

/** Opaque model-continuity message stored by a Junior conversation event. */
export type ConversationModelMessage = z.output<
  typeof conversationModelMessageSchema
>;

const messageEventDataSchema = z
  .object({
    type: z.literal("message"),
    message: conversationModelMessageSchema,
    provenance: conversationMessageProvenanceSchema.optional(),
  })
  .strict();

// Replaces the legacy `projection_reset` payload at the SQL layer: a marker plus
// ordinary message events in the new epoch, not an embedded transcript array.
const contextEpochStartedEventDataSchema = z.union([
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
    })
    .strict(),
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.union([z.literal("compaction"), z.literal("rollback")]),
      // TODO(v0.104.0): Remove support for deployed compaction/rollback markers
      // without model bindings after those rows pass the retention horizon.
      modelProfile: z.undefined().optional(),
      modelId: z.undefined().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("context_epoch_started"),
      reason: z.union([z.literal("compaction"), z.literal("rollback")]),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
    })
    .strict(),
]);

const contextEpochMessageSchema = z
  .object({
    message: conversationModelMessageSchema,
    createdAtMs: z.number().finite(),
    provenance: conversationMessageProvenanceSchema.optional(),
  })
  .strict();

/** Validate one atomically persisted context epoch. */
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
      messages: z.array(contextEpochMessageSchema),
    })
    .strict(),
  z
    .object({
      reason: z.union([z.literal("compaction"), z.literal("rollback")]),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
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
    args: z.unknown().optional(),
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
    compactions: z.array(
      z
        .object({
          coveredMessageIds: z.array(z.string()),
          createdAtMs: z.number(),
          id: z.string().min(1),
          summary: z.string(),
        })
        .strict(),
    ) satisfies z.ZodType<ConversationCompaction[]>,
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
    historyMode: z.union([z.literal("isolated"), z.literal("shared")]),
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

/** A model message written into a freshly opened context epoch. */
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
  /** All events across every epoch in `seq` order, for audit and reporting. */
  loadHistory(conversationId: string): Promise<ConversationEvent[]>;
}
