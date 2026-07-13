import { z } from "zod";
import { usageCostSchema, usageSchema } from "@/usage-schema";

export const conversationReportStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
]);

export const conversationSurfaceSchema = z.enum([
  "api",
  "internal",
  "scheduler",
  "slack",
]);

export const conversationCostSchema = usageCostSchema;

export const conversationUsageSchema = usageSchema;

export const actorIdentitySchema = z
  .object({
    email: z.string().optional(),
    fullName: z.string().optional(),
    slackUserId: z.string().optional(),
    slackUserName: z.string().optional(),
  })
  .strict();

export const conversationSummaryReportSchema = z
  .object({
    displayTitle: z.string(),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: conversationUsageSchema.optional(),
    conversationId: z.string(),
    status: conversationReportStatusSchema,
    startedAt: z.string(),
    lastSeenAt: z.string(),
    lastProgressAt: z.string(),
    surface: conversationSurfaceSchema,
    actorIdentity: actorIdentitySchema.optional(),
    channel: z.string().optional(),
    channelName: z.string().optional(),
    channelNameRedacted: z.boolean().optional(),
    locationId: z.string().optional(),
    sentryTraceUrl: z.string().optional(),
    traceId: z.string().optional(),
  })
  .strict();

export const transcriptPartTypeSchema = z.enum([
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "unknown",
]);

export const transcriptPartSchema = z
  .object({
    bytes: z.number().optional(),
    chars: z.number().optional(),
    id: z.string().optional(),
    input: z.unknown().optional(),
    inputKeys: z.array(z.string()).optional(),
    inputSizeBytes: z.number().optional(),
    inputSizeChars: z.number().optional(),
    inputType: z.string().optional(),
    name: z.string().optional(),
    output: z.unknown().optional(),
    outputKeys: z.array(z.string()).optional(),
    outputSizeBytes: z.number().optional(),
    outputSizeChars: z.number().optional(),
    outputType: z.string().optional(),
    redacted: z.boolean().optional(),
    sourceType: z.string().optional(),
    text: z.string().optional(),
    type: transcriptPartTypeSchema,
  })
  .strict();

export const transcriptRoleSchema = z.enum([
  "assistant",
  "system",
  "tool",
  "toolResult",
  "unknown",
  "user",
]);

export const transcriptMessageSchema = z
  .object({
    parts: z.array(transcriptPartSchema),
    role: transcriptRoleSchema,
    timestamp: z.number().optional(),
  })
  .strict();

export const conversationActivityStatusSchema = z.enum([
  "aborted",
  "completed",
  "error",
  "running",
  "success",
]);

export const conversationSubagentActivityReportSchema = z
  .object({
    type: z.literal("subagent"),
    createdAt: z.string(),
    endedAt: z.string().optional(),
    id: z.string(),
    modelId: z.string().optional(),
    outcome: z.enum(["success", "error", "aborted"]).optional(),
    parentToolCallId: z.string().optional(),
    reasoningLevel: z.string().optional(),
    status: conversationActivityStatusSchema,
    subagentKind: z.string(),
    transcriptAvailable: z.boolean().optional(),
  })
  .strict();

export const conversationToolActivityReportSchema = z
  .object({
    type: z.literal("tool_execution"),
    args: z.unknown().optional(),
    createdAt: z.string(),
    id: z.string(),
    inputKeys: z.array(z.string()).optional(),
    inputSizeBytes: z.number().optional(),
    inputSizeChars: z.number().optional(),
    inputType: z.string().optional(),
    redacted: z.boolean().optional(),
    status: conversationActivityStatusSchema,
    subagents: z.array(conversationSubagentActivityReportSchema),
    toolCallId: z.string(),
    toolName: z.string(),
  })
  .strict();

export const conversationActivityReportSchema = z.discriminatedUnion("type", [
  conversationToolActivityReportSchema,
  conversationSubagentActivityReportSchema,
]);

export const conversationContextEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("context_compacted"),
      createdAt: z.string(),
      modelId: z.string().optional(),
      summary: z.string().optional(),
      transcriptIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("model_handoff"),
      createdAt: z.string(),
      fromModelId: z.string().optional(),
      summary: z.string().optional(),
      toModelId: z.string(),
      transcriptIndex: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const conversationDetailReportSchema = conversationSummaryReportSchema
  .extend({
    activity: z.array(conversationActivityReportSchema).optional(),
    modelId: z.string().optional(),
    reasoningLevel: z.string().optional(),
    contextEvents: z.array(conversationContextEventSchema).optional(),
    transcriptAvailable: z.boolean(),
    transcriptMetadata: z.array(transcriptMessageSchema).optional(),
    transcriptMessageCount: z.number().optional(),
    transcriptRedacted: z.boolean().optional(),
    transcriptRedactionReason: z.literal("non_public_conversation").optional(),
    transcriptExpired: z.boolean().optional(),
    transcriptExpiredAt: z.string().optional(),
    transcript: z.array(transcriptMessageSchema),
    generatedAt: z.string(),
    sentryConversationUrl: z.string().optional(),
  })
  .strict();

export const conversationSubagentTranscriptReportSchema = z
  .object({
    type: z.literal("subagent"),
    createdAt: z.string(),
    endedAt: z.string().optional(),
    id: z.string(),
    modelId: z.string().optional(),
    outcome: z.enum(["success", "error", "aborted"]).optional(),
    parentToolCallId: z.string().optional(),
    reasoningLevel: z.string().optional(),
    status: conversationActivityStatusSchema,
    subagentConversationId: z.string().optional(),
    subagentKind: z.string(),
    subagentSentryConversationUrl: z.string().optional(),
    transcript: z.array(transcriptMessageSchema),
    transcriptAvailable: z.boolean(),
    transcriptMessageCount: z.number().optional(),
    transcriptRedacted: z.boolean().optional(),
    transcriptRedactionReason: z.literal("non_public_conversation").optional(),
    transcriptExpired: z.boolean().optional(),
    transcriptExpiredAt: z.string().optional(),
    unavailableReason: z
      .enum(["missing_transcript_range", "missing_transcript_ref", "not_found"])
      .optional(),
  })
  .strict();

export const conversationFeedSchema = z
  .object({
    conversations: z.array(conversationSummaryReportSchema),
    source: z.literal("conversation_index"),
    generatedAt: z.string(),
  })
  .strict();

export const conversationStatsItemSchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    label: z.string(),
    costUsd: z.number().optional(),
    tokens: z.number().optional(),
  })
  .strict();

export const conversationStatsReportSchema = z
  .object({
    active: z.number(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    generatedAt: z.string(),
    locations: z.array(conversationStatsItemSchema),
    actors: z.array(conversationStatsItemSchema),
    sampleLimit: z.number(),
    sampleSize: z.number(),
    source: z.literal("conversation_index"),
    costUsd: z.number().optional(),
    tokens: z.number().optional(),
    truncated: z.boolean(),
    windowEnd: z.string(),
    windowStart: z.string(),
  })
  .strict();

export type ConversationReportStatus = z.infer<
  typeof conversationReportStatusSchema
>;
export type ConversationSurface = z.infer<typeof conversationSurfaceSchema>;
export type ConversationCost = z.infer<typeof conversationCostSchema>;
export type ConversationUsage = z.infer<typeof conversationUsageSchema>;
export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type ConversationSummaryReport = z.infer<
  typeof conversationSummaryReportSchema
>;
export type TranscriptPartType = z.infer<typeof transcriptPartTypeSchema>;
export type TranscriptPart = z.infer<typeof transcriptPartSchema>;
export type TranscriptRole = z.infer<typeof transcriptRoleSchema>;
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type ConversationContextEvent = z.infer<
  typeof conversationContextEventSchema
>;
export type ConversationActivityStatus = z.infer<
  typeof conversationActivityStatusSchema
>;
export type ConversationSubagentActivityReport = z.infer<
  typeof conversationSubagentActivityReportSchema
>;
export type ConversationToolActivityReport = z.infer<
  typeof conversationToolActivityReportSchema
>;
export type ConversationActivityReport = z.infer<
  typeof conversationActivityReportSchema
>;
export type ConversationDetailReport = z.infer<
  typeof conversationDetailReportSchema
>;
export type ConversationSubagentTranscriptReport = z.infer<
  typeof conversationSubagentTranscriptReportSchema
>;
export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
export type ConversationStatsItem = z.infer<typeof conversationStatsItemSchema>;
export type ConversationStatsReport = z.infer<
  typeof conversationStatsReportSchema
>;
