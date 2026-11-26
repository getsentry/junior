// Agent history items and History replacements: the event types that core
// replays to the model. Every other event type is the host's.
import * as z from "zod";
import { conversationMessageProvenanceSchema } from "@/chat/conversations/provenance";

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

// A Pi system message after the leading one. The leading one is rebuilt for
// each slice and never saved.
const systemMessageEventDataSchema = z
  .object({
    type: z.literal("system_message"),
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
  systemMessageEventDataSchema,
]);

/** A native replayable agent-history item. */
export type AgentHistoryItem = z.output<typeof agentHistoryItemSchema>;

const nativeReplacementHistoryItemSchema = z
  .object({
    item: agentHistoryItemSchema,
    // Preserve the copied item's position when a turn resumes. Synthetic
    // summary items have no source event.
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

// Model profiles are retired. Stored rows may still carry `modelProfile`.
const legacyModelProfileSchema = z.string().min(1).optional();

const historyReplacementEventDataSchema = z
  .object({
    type: z.literal("compaction"),
    modelProfile: legacyModelProfileSchema,
    modelId: z.string().min(1),
    details: compactionDetailsSchema.optional(),
    // Estimated cost of the summary requests. A swap of a prepared summary
    // makes no model call, so it has none.
    costUsd: z.number().finite().nonnegative().optional(),
    summary: z.string().min(1).optional(),
    replacementHistory: replacementHistorySchema,
  })
  .strict();

// Model handoff is retired. Stored handoff rows still start a History version,
// so replay reads their replacement history. Nothing writes new ones.
const legacyHandoffEventDataSchema = z
  .object({
    type: z.literal("handoff"),
    modelProfile: legacyModelProfileSchema,
    modelId: z.string().min(1),
    reasoningLevel: z.string().min(1).optional(),
    triggeringToolCallId: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    replacementHistory: replacementHistorySchema,
  })
  .strict();

/** The data of an event that replaces the active agent history. */
export const historyReplacementDataSchema = z.discriminatedUnion("type", [
  historyReplacementEventDataSchema,
  legacyHandoffEventDataSchema,
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
