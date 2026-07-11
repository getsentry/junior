/**
 * Durable agent execution history port.
 *
 * Steps are appended one row at a time under the conversation lease; context
 * rebuilds (compaction, handoff, rollback) open a new context epoch instead of
 * rewriting history. Each new epoch binds the model profile that owns it and
 * records the exact resolved model id for audit.
 * The step envelope is strictly validated — an unknown type or malformed shape
 * is corrupt state and fails loudly — while `pi_message` content stays
 * permissive because the Pi SDK owns the message shape.
 */
import { z } from "zod";
import { piMessageSchema } from "@/chat/pi/messages";
import type { ConversationCompaction } from "@/chat/state/conversation";
import { piMessageProvenanceSchema } from "@/chat/state/session-log";
import { modelProfileSchema } from "@/chat/model-profile";

const handoffModelProfileSchema = modelProfileSchema.refine(
  (profile) => profile !== "standard",
  "handoff profile must not be standard",
);

const piMessageStepEntrySchema = z.object({
  type: z.literal("pi_message"),
  schemaVersion: z.number().int().optional(),
  message: piMessageSchema,
  provenance: piMessageProvenanceSchema.optional(),
});

// Replaces the legacy `projection_reset` payload at the SQL layer: a marker plus
// ordinary pi_message rows in the new epoch, not an embedded transcript array.
const contextEpochStartedEntrySchema = z.union([
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
      // TODO(v0.97.0): Remove support for deployed compaction/rollback markers
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

const piMessageStepSchema = z
  .object({
    message: piMessageSchema,
    createdAtMs: z.number().finite(),
    provenance: piMessageProvenanceSchema.optional(),
  })
  .strict();

/** Validate one atomically persisted context epoch. */
export const contextEpochStartSchema = z.discriminatedUnion("reason", [
  z
    .object({
      reason: z.literal("initial"),
      modelProfile: z.literal("standard"),
      modelId: z.string().min(1),
      messages: z.array(piMessageStepSchema),
    })
    .strict(),
  z
    .object({
      reason: z.literal("handoff"),
      modelProfile: handoffModelProfileSchema,
      modelId: z.string().min(1),
      messages: z.array(piMessageStepSchema),
    })
    .strict(),
  z
    .object({
      reason: z.union([z.literal("compaction"), z.literal("rollback")]),
      modelProfile: modelProfileSchema,
      modelId: z.string().min(1),
      messages: z.array(piMessageStepSchema),
    })
    .strict(),
]);

/** One atomically persisted context epoch and its model binding. */
export type ContextEpochStart = z.output<typeof contextEpochStartSchema>;

const mcpProviderConnectedEntrySchema = z.object({
  type: z.literal("mcp_provider_connected"),
  provider: z.string().min(1),
});

const authorizationKindSchema = z.union([
  z.literal("plugin"),
  z.literal("mcp"),
]);

const authorizationRequestedEntrySchema = z.object({
  type: z.literal("authorization_requested"),
  kind: authorizationKindSchema,
  provider: z.string().min(1),
  actorId: z.string().min(1),
  authorizationId: z.string().min(1),
  delivery: z.union([
    z.literal("private_link_sent"),
    z.literal("private_link_reused"),
  ]),
});

const authorizationCompletedEntrySchema = z.object({
  type: z.literal("authorization_completed"),
  kind: authorizationKindSchema,
  provider: z.string().min(1),
  actorId: z.string().min(1),
  authorizationId: z.string().min(1),
});

const toolExecutionStartedEntrySchema = z.object({
  type: z.literal("tool_execution_started"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown().optional(),
});

const visibleContextCompactedEntrySchema = z.object({
  type: z.literal("visible_context_compacted"),
  compactions: z.array(
    z.object({
      coveredMessageIds: z.array(z.string()),
      createdAtMs: z.number(),
      id: z.string().min(1),
      summary: z.string(),
    }),
  ) satisfies z.ZodType<ConversationCompaction[]>,
});

// Subagent histories are child conversations; the marker references the child by
// its own conversation id rather than a polymorphic transcript locator.
const subagentStartedEntrySchema = z
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

const subagentEndedEntrySchema = z.object({
  type: z.literal("subagent_ended"),
  subagentInvocationId: z.string().min(1),
  outcome: z.union([
    z.literal("success"),
    z.literal("error"),
    z.literal("aborted"),
  ]),
  errorCode: z.string().min(1).optional(),
});

/** Prevent ordinary appends from bypassing context-epoch lifecycle validation. */
const appendableAgentStepEntrySchema = z.union([
  piMessageStepEntrySchema,
  mcpProviderConnectedEntrySchema,
  authorizationRequestedEntrySchema,
  authorizationCompletedEntrySchema,
  toolExecutionStartedEntrySchema,
  visibleContextCompactedEntrySchema,
  subagentStartedEntrySchema,
  subagentEndedEntrySchema,
]);

/** Strict step envelope reused by the SQL row codec; unknown types fail loudly. */
export const agentStepEntrySchema = z.union([
  appendableAgentStepEntrySchema,
  contextEpochStartedEntrySchema,
]);

/** One durable execution step's validated payload (sessionId lifted to epoch). */
export type AgentStepEntry = z.infer<typeof agentStepEntrySchema>;

/** A step read back from storage with its assigned order and epoch. */
export interface StoredAgentStep {
  seq: number;
  contextEpoch: number;
  createdAtMs: number;
  entry: AgentStepEntry;
}

/** Validate a current-epoch append without permitting epoch markers. */
export const newAgentStepSchema = z
  .object({
    entry: appendableAgentStepEntrySchema,
    createdAtMs: z.number().finite(),
  })
  .strict();

/** A step to append; the store assigns `seq` and the current `context_epoch`. */
export type NewAgentStep = z.output<typeof newAgentStepSchema>;

/** A replacement Pi message written into a freshly opened epoch. */
export type PiMessageStep = z.output<typeof piMessageStepSchema>;

/** Persist and read the durable per-conversation agent execution history. */
export interface AgentStepStore {
  /** Append steps in one transaction, assigning `seq = max+1` under the lease. */
  append(conversationId: string, steps: NewAgentStep[]): Promise<void>;
  /**
   * Open initial epoch 0 or the next replacement epoch in one transaction.
   */
  startEpoch(conversationId: string, opts: ContextEpochStart): Promise<void>;
  /** Steps of the highest epoch in `seq` order (all types; caller filters). */
  loadCurrentEpoch(conversationId: string): Promise<StoredAgentStep[]>;
  /** All steps across all epochs in `seq` order, for audit and reporting. */
  loadHistory(conversationId: string): Promise<StoredAgentStep[]>;
}
