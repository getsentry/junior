import { z } from "zod";
import { usageCostSchema, usageSchema } from "@/usage-schema";
import {
  conversationAnnotationInputSchema,
  conversationEventPresentationSchema,
} from "@sentry/junior-plugin-api";

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

export const conversationParamsSchema = z
  .object({ conversationId: z.string().min(1) })
  .strict();

export const conversationPendingMessageParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    inboundMessageId: z.string().min(1),
  })
  .strict();

export const conversationDetailQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1_000).default(500),
  })
  .strict();

export const conversationEventsQuerySchema = z
  .object({
    before: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(1_000).default(500),
  })
  .strict();

export const conversationFeedQuerySchema = z
  .object({
    actorEmail: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict();

export const archiveConversationBodySchema = z
  .object({ archived: z.boolean(), lastSeenAt: z.string().datetime() })
  .strict();

export const archiveConversationResponseSchema = z
  .object({ archived: z.boolean() })
  .strict();

export const createConversationBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(32_000),
    /** New roots default public. Private roots stay participant-only. */
    visibility: z.enum(["private", "public"]).optional(),
  })
  .strict();

export const createConversationMessageBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(32_000),
  })
  .strict();

export const acceptedConversationMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    status: z.enum(["accepted", "duplicate"]),
  })
  .strict();

export const actorIdentitySchema = z
  .object({
    email: z.string().optional(),
    fullName: z.string().optional(),
    slackUserId: z.string().optional(),
    slackUserName: z.string().optional(),
  })
  .strict();

/** Mailbox delivery mode for one accepted inbound message. */
export const conversationPendingMessageDeliverySchema = z.enum([
  "defer",
  "interrupt",
]);

/** One accepted mailbox message that has not reached durable history yet. */
export const conversationPendingMessageSchema = z
  .object({
    actorIdentity: actorIdentitySchema.optional(),
    createdAt: z.string().datetime(),
    delivery: conversationPendingMessageDeliverySchema,
    inboundMessageId: z.string().min(1),
    messageId: z.string().min(1),
    receivedAt: z.string().datetime(),
    role: z.literal("user"),
    source: z.enum(["slack", "web"]),
    text: z.string().optional(),
    redacted: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.text === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "pending message content must be text or explicitly redacted",
      });
    }
    if (data.redacted && data.actorIdentity) {
      context.addIssue({
        code: "custom",
        message: "redacted pending messages must not expose actor identity",
      });
    }
  });

/** Participant-only authorization prompt for a parked web turn. */
export const conversationPendingAuthorizationSchema = z
  .object({
    authorizationUrl: z.string().url(),
    completionText: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

/** Bounded mailbox snapshot for one conversation transcript. */
export const conversationPendingMessagesReportSchema = z
  .object({
    authorization: conversationPendingAuthorizationSchema.optional(),
    conversationId: z.string().min(1),
    generatedAt: z.string().datetime(),
    messages: z.array(conversationPendingMessageSchema),
  })
  .strict();

export const conversationAuxiliaryCostsSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    operations: z
      .array(
        z
          .object({
            costUsd: z.number().finite().nonnegative(),
            events: z.number().int().positive(),
            name: z.string().min(1),
            namespace: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Optional reverse link from a task-triggered conversation back to its task. */
export const conversationSourceTaskSchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: z.enum(["scheduled", "event"]),
    label: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.id) !== Boolean(value.label)) {
      context.addIssue({
        code: "custom",
        message: "sourceTask id and label must both be set or both omitted",
      });
    }
  });

export const conversationSummaryReportSchema = z
  .object({
    displayTitle: z.string(),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: conversationUsageSchema.optional(),
    auxiliaryCosts: conversationAuxiliaryCostsSchema.optional(),
    conversationId: z.string(),
    isParticipant: z.boolean(),
    visibility: z.enum(["private", "public"]).optional(),
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
    sourceUrl: z.string().url().optional(),
    traceId: z.string().optional(),
  })
  .strict();

const conversationReportMessageEventDataSchema = z
  .object({
    type: z.literal("message"),
    messageId: z.string().min(1),
    role: z.enum(["assistant", "system", "user"]),
    source: z.literal("web").optional(),
    actorIdentity: actorIdentitySchema.optional(),
    eventType: z.string().min(1).optional(),
    explicitMention: z.boolean().optional(),
    text: z.string().optional(),
    redacted: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.text === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "message content must be text or explicitly redacted",
      });
    }
    if (data.redacted && data.actorIdentity) {
      context.addIssue({
        code: "custom",
        message: "redacted messages must not expose actor identity",
      });
    }
  });

const conversationReportMessageHandledEventDataSchema = z
  .object({
    type: z.literal("message_handled"),
    messageId: z.string().min(1),
  })
  .strict();

const conversationReportToolCallSchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["running", "completed", "error"]),
    startedAt: z.string().datetime().optional(),
    startedSeq: z.number().int().nonnegative().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict()
  .superRefine((call, context) => {
    if ((call.startedAt === undefined) !== (call.startedSeq === undefined)) {
      context.addIssue({
        code: "custom",
        message: "tool start sequence and timestamp must be provided together",
      });
    }
  });

const conversationReportReasoningPartSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string().min(1).optional(),
    redacted: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if ((data.text === undefined) === (data.redacted !== true)) {
      context.addIssue({
        code: "custom",
        message: "reasoning content must be text or explicitly redacted",
      });
    }
  });

const conversationReportAssistantToolCallPartSchema = z
  .object({
    type: z.literal("tool_call"),
    toolCallId: z.string().min(1),
  })
  .strict();

const conversationReportAssistantMetadataSchema = z
  .object({
    parts: z
      .array(
        z.discriminatedUnion("type", [
          conversationReportReasoningPartSchema,
          conversationReportAssistantToolCallPartSchema,
        ]),
      )
      .min(1),
  })
  .strict();

const conversationReportToolCallsEventDataSchema = z
  .object({
    type: z.literal("tool_calls"),
    calls: z.array(conversationReportToolCallSchema).min(1),
    assistant: conversationReportAssistantMetadataSchema.optional(),
  })
  .strict()
  .superRefine((data, context) => {
    if (!data.assistant) return;
    const callCounts = new Map<string, number>();
    for (const call of data.calls) {
      callCounts.set(
        call.toolCallId,
        (callCounts.get(call.toolCallId) ?? 0) + 1,
      );
    }
    const partCounts = new Map<string, number>();
    for (const part of data.assistant.parts) {
      if (part.type !== "tool_call") continue;
      partCounts.set(
        part.toolCallId,
        (partCounts.get(part.toolCallId) ?? 0) + 1,
      );
    }
    if (
      callCounts.size !== partCounts.size ||
      [...callCounts].some(
        ([toolCallId, count]) => partCounts.get(toolCallId) !== count,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["assistant", "parts"],
        message: "assistant tool parts must reference every call exactly once",
      });
    }
  });

const conversationReportAssistantMessageEventDataSchema = z
  .object({
    type: z.literal("assistant_message"),
    parts: z.array(conversationReportReasoningPartSchema).min(1),
  })
  .strict();

const conversationReportTurnLifecycleEventDataSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        type: z.literal("turn_lifecycle"),
        turnId: z.string().min(1),
        state: z.enum(["succeeded", "no_reply"]),
      })
      .strict(),
    z
      .object({
        type: z.literal("turn_lifecycle"),
        turnId: z.string().min(1),
        state: z.literal("started"),
        inputMessageIds: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("turn_lifecycle"),
        turnId: z.string().min(1),
        state: z.literal("failed"),
        failureKind: z.enum(["agent", "delivery"]),
      })
      .strict(),
  ],
);

const conversationReportTurnRoutedEventDataSchema = z
  .object({
    type: z.literal("turn_routed"),
    turnId: z.string().min(1),
    modelProfile: z.string().min(1),
    modelId: z.string().min(1),
    costUsd: z.number().finite().nonnegative().optional(),
    reasoningLevel: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    source: z.enum(["configured", "inherited", "router"]),
  })
  .strict();

const conversationReportGuardianActionReviewedEventDataSchema = z
  .object({
    type: z.literal("guardian_action_reviewed"),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    decision: z.enum(["allow", "ask", "deny"]),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    userAuthorization: z.enum(["high", "medium", "low", "unknown"]),
  })
  .strict();

const conversationReportTurnContextEventDataSchema = z
  .object({
    type: z.literal("turn_context"),
    turnId: z.string().min(1),
    pluginName: z.string().min(1),
    kind: z.string().min(1),
    version: z.number().int().positive(),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

const conversationReportStructuredEventDataSchema = z
  .object({
    type: z.literal("structured_event"),
    namespace: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    turnId: z.string().min(1).optional(),
    presentation: conversationEventPresentationSchema,
  })
  .strict();

const conversationReportCompactionEventDataSchema = z
  .object({
    type: z.literal("compaction"),
    modelProfile: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    details: z
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
      .strict()
      .optional(),
  })
  .strict();

const conversationReportHandoffEventDataSchema = z
  .object({
    type: z.literal("handoff"),
    modelProfile: z.string().min(1),
    modelId: z.string().min(1),
    reasoningLevel: z.string().min(1).optional(),
    triggeringToolCallId: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
  })
  .strict();

const conversationReportSubagentEventDataSchema = z
  .object({
    type: z.literal("subagent"),
    startedSeq: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    childConversationId: z.string().min(1),
    subagentKind: z.string().min(1),
    parentToolCallId: z.string().min(1).optional(),
    status: z.enum(["running", "completed", "error", "aborted"]),
  })
  .strict();

/** Privacy-safe event variants owned by the conversation reporting API. */
export const conversationReportEventDataSchema = z.discriminatedUnion("type", [
  conversationReportMessageEventDataSchema,
  conversationReportMessageHandledEventDataSchema,
  conversationReportAssistantMessageEventDataSchema,
  conversationReportToolCallsEventDataSchema,
  conversationReportTurnLifecycleEventDataSchema,
  conversationReportTurnContextEventDataSchema,
  conversationReportStructuredEventDataSchema,
  conversationReportTurnRoutedEventDataSchema,
  conversationReportGuardianActionReviewedEventDataSchema,
  conversationReportCompactionEventDataSchema,
  conversationReportHandoffEventDataSchema,
  conversationReportSubagentEventDataSchema,
]);

/** One ordered, privacy-safe canonical event projected for API consumers. */
export const conversationReportEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
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

/** Enforce event ordering and history visibility across paginated wire payloads. */
function validateConversationEvents(
  report: {
    eventHistory: z.infer<typeof conversationEventHistorySchema>;
    events: z.infer<typeof conversationReportEventSchema>[];
  },
  context: z.RefinementCtx,
): void {
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
    if (event.data.type === "message") {
      if (
        report.eventHistory.status === "redacted" &&
        event.data.redacted !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "data"],
          message: "redacted event history must redact messages",
        });
      }
      if (
        report.eventHistory.status === "available" &&
        event.data.redacted === true
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "data"],
          message: "available event history must expose messages",
        });
      }
    }
    if (
      report.eventHistory.status === "redacted" &&
      event.data.type === "tool_calls" &&
      event.data.calls.some(
        (call) => call.input !== undefined || call.output !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "data"],
        message: "redacted event history must redact tool payloads",
      });
    }
    if (
      report.eventHistory.status === "redacted" &&
      event.data.type === "assistant_message" &&
      event.data.parts.some((part) => part.text !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "data"],
        message: "redacted event history must redact assistant messages",
      });
    }
    if (
      report.eventHistory.status === "available" &&
      event.data.type === "assistant_message" &&
      event.data.parts.some((part) => part.redacted === true)
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "data"],
        message: "available event history must expose reasoning",
      });
    }
    if (
      event.data.type === "tool_calls" &&
      ((report.eventHistory.status === "redacted" &&
        event.data.assistant?.parts.some(
          (part) => part.type === "reasoning" && part.text !== undefined,
        )) ||
        (report.eventHistory.status === "available" &&
          event.data.assistant?.parts.some(
            (part) => part.type === "reasoning" && part.redacted === true,
          )))
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "data", "assistant"],
        message: "assistant reasoning must match event history visibility",
      });
    }
  }
}

export const conversationDetailReportSchema = conversationSummaryReportSchema
  .extend({
    annotations: z
      .array(
        conversationAnnotationInputSchema.and(
          z.object({
            plugin: z.string().min(1),
            createdAt: z.string().datetime(),
            updatedAt: z.string().datetime(),
          }),
        ),
      )
      .optional(),
    modelUsage: z.array(conversationModelUsageSchema).optional(),
    events: z.array(conversationReportEventSchema),
    eventHistory: conversationEventHistorySchema,
    previousCursor: z.string().min(1).optional(),
    generatedAt: z.string(),
    sentryConversationUrl: z.string().optional(),
    sourceTask: conversationSourceTaskSchema.optional(),
  })
  .strict()
  .superRefine(validateConversationEvents);

export const conversationEventPageSchema = z
  .object({
    events: z.array(conversationReportEventSchema),
    eventHistory: conversationEventHistorySchema,
    previousCursor: z.string().min(1).optional(),
    generatedAt: z.string(),
  })
  .strict()
  .superRefine(validateConversationEvents);

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
    cachedInputTokens: z.number().optional(),
    conversations: z.number(),
    costUsd: z.number().optional(),
    date: z.string(),
    durationMs: z.number(),
    inputTokens: z.number().optional(),
    tokens: z.number().optional(),
  })
  .strict();

export const guardianMetricDaySchema = z
  .object({
    allow: z.number(),
    ask: z.number(),
    costUsd: z.number().optional(),
    date: z.string(),
    deny: z.number(),
    requests: z.number(),
  })
  .strict();

export const guardianStatsSchema = z
  .object({
    allow: z.number(),
    ask: z.number(),
    costUsd: z.number().optional(),
    deny: z.number(),
    metricDays: z.array(guardianMetricDaySchema),
    requests: z.number(),
  })
  .strict();

export const conversationStatsReportSchema = z
  .object({
    active: z.number(),
    cachedInputTokens: z.number().optional(),
    conversations: z.number(),
    durationMs: z.number(),
    failed: z.number(),
    generatedAt: z.string(),
    guardian: guardianStatsSchema,
    metricDays: z.array(conversationMetricDaySchema),
    locations: z.array(conversationStatsItemSchema),
    actors: z.array(conversationStatsItemSchema),
    source: z.literal("conversation_index"),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
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
export type ConversationAuxiliaryCosts = z.infer<
  typeof conversationAuxiliaryCostsSchema
>;
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
export type ConversationSourceTask = z.infer<
  typeof conversationSourceTaskSchema
>;
export type ConversationDetailReport = z.infer<
  typeof conversationDetailReportSchema
>;
export type ConversationEventPage = z.infer<typeof conversationEventPageSchema>;
export type ConversationFeed = z.infer<typeof conversationFeedSchema>;
export type ConversationStatsItem = z.infer<typeof conversationStatsItemSchema>;
export type ConversationMetricDay = z.infer<typeof conversationMetricDaySchema>;
export type GuardianMetricDay = z.infer<typeof guardianMetricDaySchema>;
export type GuardianStats = z.infer<typeof guardianStatsSchema>;
export type ConversationStatsReport = z.infer<
  typeof conversationStatsReportSchema
>;
export type ConversationParams = z.infer<typeof conversationParamsSchema>;
export type ArchiveConversationBody = z.infer<
  typeof archiveConversationBodySchema
>;
export type ArchiveConversationResponse = z.infer<
  typeof archiveConversationResponseSchema
>;
export type CreateConversationBody = z.infer<
  typeof createConversationBodySchema
>;
export type CreateConversationMessageBody = z.infer<
  typeof createConversationMessageBodySchema
>;
export type AcceptedConversationMessage = z.infer<
  typeof acceptedConversationMessageSchema
>;
export type ConversationPendingMessageDelivery = z.infer<
  typeof conversationPendingMessageDeliverySchema
>;
export type ConversationPendingMessage = z.infer<
  typeof conversationPendingMessageSchema
>;
export type ConversationPendingMessagesReport = z.infer<
  typeof conversationPendingMessagesReportSchema
>;
