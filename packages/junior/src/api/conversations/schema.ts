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
    archivedAt: z.string().optional(),
    channel: z.string().optional(),
    channelName: z.string().optional(),
    channelNameRedacted: z.boolean().optional(),
    locationId: z.string().optional(),
    sentryTraceUrl: z.string().optional(),
    traceId: z.string().optional(),
  })
  .strict();

const conversationReportVisibleMessageEventDataSchema = z
  .object({
    type: z.literal("visible_message"),
    messageId: z.string().min(1),
    role: z.enum(["assistant", "system", "user"]),
    text: z.string().optional(),
    redacted: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.text === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "visible message content must be text or explicitly redacted",
      });
    }
  });

const conversationReportVisibleMessageRepliedEventDataSchema = z
  .object({
    type: z.literal("visible_message_replied"),
    messageId: z.string().min(1),
  })
  .strict();

const conversationReportModelActivityEventDataSchema = z
  .object({
    type: z.literal("model_activity"),
    activities: z
      .array(z.enum(["thinking", "tool_call", "tool_result"]))
      .min(1),
  })
  .strict()
  .superRefine((data, context) => {
    if (new Set(data.activities).size !== data.activities.length) {
      context.addIssue({
        code: "custom",
        message: "model activities must be unique",
      });
    }
  });

const conversationReportToolStartedEventDataSchema = z
  .object({
    type: z.literal("tool_started"),
    name: z.string().min(1),
  })
  .strict();

const conversationReportTurnLifecycleEventDataSchema = z
  .object({
    type: z.literal("turn_lifecycle"),
    turnId: z.string().min(1),
    state: z.enum(["started", "succeeded", "no_reply", "failed"]),
  })
  .strict();

const conversationReportContextCompactedEventDataSchema = z
  .object({ type: z.literal("context_compacted") })
  .strict();

const conversationReportModelHandoffEventDataSchema = z
  .object({ type: z.literal("model_handoff") })
  .strict();

const conversationReportDeliveryEventDataSchema = z
  .object({
    type: z.literal("delivery"),
    deliveryId: z.string().min(1),
    state: z.enum(["intended", "accepted", "failed"]),
  })
  .strict();

const conversationReportSubagentStartedEventDataSchema = z
  .object({
    type: z.literal("subagent_started"),
    childConversationId: z.string().min(1),
    subagentKind: z.string().min(1),
    historyMode: z.enum(["isolated", "shared"]),
  })
  .strict();

const conversationReportSubagentEndedEventDataSchema = z
  .object({
    type: z.literal("subagent_ended"),
    childConversationId: z.string().min(1),
    subagentKind: z.string().min(1),
    historyMode: z.enum(["isolated", "shared"]),
    outcome: z.enum(["success", "error", "aborted"]),
  })
  .strict();

/** Privacy-safe event variants owned by the conversation reporting API. */
export const conversationReportEventDataSchema = z.discriminatedUnion("type", [
  conversationReportVisibleMessageEventDataSchema,
  conversationReportVisibleMessageRepliedEventDataSchema,
  conversationReportModelActivityEventDataSchema,
  conversationReportToolStartedEventDataSchema,
  conversationReportTurnLifecycleEventDataSchema,
  conversationReportContextCompactedEventDataSchema,
  conversationReportModelHandoffEventDataSchema,
  conversationReportDeliveryEventDataSchema,
  conversationReportSubagentStartedEventDataSchema,
  conversationReportSubagentEndedEventDataSchema,
]);

/** One ordered, privacy-safe canonical event projected for API consumers. */
export const conversationReportEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    contextEpoch: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    data: conversationReportEventDataSchema,
  })
  .strict();

/** Availability of the canonical event history attached to a detail report. */
export const conversationEventHistorySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }).strict(),
  z
    .object({
      status: z.literal("redacted"),
      reason: z.literal("non_public_conversation"),
    })
    .strict(),
  z
    .object({
      status: z.literal("expired"),
      expiredAt: z.string().datetime(),
    })
    .strict(),
]);

export const conversationModelUsageSchema = z
  .object({
    modelId: z.string(),
    usage: conversationUsageSchema,
  })
  .strict();

export const conversationDetailReportSchema = conversationSummaryReportSchema
  .extend({
    modelUsage: z.array(conversationModelUsageSchema).optional(),
    events: z.array(conversationReportEventSchema),
    eventHistory: conversationEventHistorySchema,
    generatedAt: z.string(),
    sentryConversationUrl: z.string().optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.eventHistory.status === "expired" && report.events.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "expired event history must not contain events",
      });
    }
    for (let index = 1; index < report.events.length; index += 1) {
      if (report.events[index]!.seq <= report.events[index - 1]!.seq) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "seq"],
          message: "report event sequences must be strictly increasing",
        });
      }
    }
    for (const [index, event] of report.events.entries()) {
      if (event.data.type !== "visible_message") continue;
      if (
        report.eventHistory.status === "redacted" &&
        event.data.redacted !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "data"],
          message: "redacted event history must redact visible messages",
        });
      }
      if (
        report.eventHistory.status === "available" &&
        event.data.redacted === true
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "data"],
          message: "available event history must expose visible messages",
        });
      }
    }
  });

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

export const conversationMetricDaySchema = z
  .object({
    costUsd: z.number().optional(),
    date: z.string(),
    durationMs: z.number(),
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
    metricDays: z.array(conversationMetricDaySchema),
    locations: z.array(conversationStatsItemSchema),
    actors: z.array(conversationStatsItemSchema),
    source: z.literal("conversation_index"),
    costUsd: z.number().optional(),
    tokens: z.number().optional(),
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
export type ConversationModelUsage = z.infer<
  typeof conversationModelUsageSchema
>;
export type ConversationReportEventData = z.infer<
  typeof conversationReportEventDataSchema
>;
export type ConversationReportEvent = z.infer<
  typeof conversationReportEventSchema
>;
export type ConversationEventHistory = z.infer<
  typeof conversationEventHistorySchema
>;
export type ConversationDetailReport = z.infer<
  typeof conversationDetailReportSchema
>;
export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
export type ConversationStatsItem = z.infer<typeof conversationStatsItemSchema>;
export type ConversationMetricDay = z.infer<typeof conversationMetricDaySchema>;
export type ConversationStatsReport = z.infer<
  typeof conversationStatsReportSchema
>;
