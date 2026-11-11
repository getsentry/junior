import {
  inputImageSchema,
  MAX_INPUT_IMAGES,
  MAX_INPUT_IMAGE_BYTES,
  messageAttachmentSchema,
} from "@/chat/attachments/input";
import { messageCardRefSchema } from "@/chat/conversations/cards";
import { reviewItemChangeRecordSchema } from "@/chat/review-items/change-record";
import * as z from "zod";
import { conversationReadPositionSchema } from "./conversation-read-position";
import { conversationTitleSchema } from "./conversation-title";
import { objectTypeSchema } from "@sentry/junior-plugin-api";
import {
  conversationTurnFailureCodeSchema,
  conversationTurnFailureReasonSchema,
} from "@/chat/conversations/history";
import { conversationBriefSchema } from "@/chat/briefs/schema";
import { usageCostSchema, usageSchema } from "@/usage-schema";
import { conversationChildAgentTotalsSchema } from "./child-agent-totals";
import {
  conversationAnnotationInputSchema,
  conversationSidebarAnnotationSchema,
  conversationEventPresentationSchema,
} from "@sentry/junior-plugin-api";

export {
  conversationTurnFailureCodeSchema,
  conversationTurnFailureReasonSchema,
};

export const conversationReportStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "stopped",
]);

/** Where a Conversation sits in its tree. See `TERMINOLOGY.md`. */
const conversationKindSchema = z.enum(["root", "automation", "thread", "task"]);

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

export const conversationAttachmentParamsSchema = z
  .object({
    attachmentId: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .strict();

/**
 * Events in a default dashboard page. A read costs a fixed ~15 ms plus about
 * 0.1 ms and 600 bytes per event, so this cap keeps a page within about twice
 * the fixed cost. Smaller pages save little and need more requests.
 */
export const CONVERSATION_EVENT_PAGE_LIMIT = 150;

export const conversationDetailQuerySchema = z
  .object({
    /** Omit to get the latest three Turns, up to the default page limit. */
    limit: z.coerce.number().int().min(1).max(1_000).optional(),
    /** Also return `unreadPage` when the detail has an `unreadCursor`. */
    unreadPage: z.stringbool().optional(),
    /**
     * Also return `mailbox`, read before history. A sent version that still
     * matches gets `{ unchanged: true, mailbox }` instead of 304, so a poll
     * needs one request.
     */
    mailbox: z.stringbool().optional(),
    /**
     * An `appendCursor` from an earlier detail. Events then hold only newer
     * events, with `appended: true`, while the cursor still applies.
     */
    after: z.string().min(1).optional(),
  })
  .strict();

const conversationEventsLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(1_000)
  .default(CONVERSATION_EVENT_PAGE_LIMIT);

/**
 * Page toward the start with `before`, toward the latest with `after`, or
 * both ways from one event with `around`. A link target asks for the page
 * around one event by its `event` seq, or around the start of a `turn`.
 */
export const conversationEventsQuerySchema = z.union([
  z
    .object({ before: z.string().min(1), limit: conversationEventsLimitSchema })
    .strict(),
  z
    .object({ after: z.string().min(1), limit: conversationEventsLimitSchema })
    .strict(),
  z
    .object({ around: z.string().min(1), limit: conversationEventsLimitSchema })
    .strict(),
  z
    .object({
      event: z.coerce.number().int().min(0),
      limit: conversationEventsLimitSchema,
    })
    .strict(),
  z
    .object({ turn: z.string().min(1), limit: conversationEventsLimitSchema })
    .strict(),
]);

export const conversationFeedQuerySchema = z
  .object({
    actorEmail: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    codeRepositoryId: z.string().uuid().optional(),
    q: z.string().trim().max(200).optional(),
    status: z.enum(["active", "archived"]).default("active"),
  })
  .strict();

export const createConversationMessageBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    message: z.string().trim().max(32_000),
    images: z.array(inputImageSchema).max(MAX_INPUT_IMAGES).optional(),
  })
  .strict()
  .refine(
    (body) => Boolean(body.message || body.images?.length),
    "Add a message or an image.",
  )
  .refine(
    (body) =>
      (body.images ?? []).reduce((sum, image) => sum + image.data.length, 0) <=
      (MAX_INPUT_IMAGE_BYTES * 4) / 3,
    "Images must total 3 MB or less.",
  );

export const createConversationBodySchema =
  createConversationMessageBodySchema.safeExtend({
    /** Saved title. Title generation runs only when it is omitted. */
    title: conversationTitleSchema.optional(),
    /** New roots default public. Private roots stay participant-only. */
    visibility: z.enum(["private", "public"]).optional(),
  });

export const acceptedConversationMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    status: z.enum(["accepted", "duplicate"]),
  })
  .strict();

export const actorIdentitySchema = z
  .object({
    /**
     * Junior API path of the profile photo: the person's Slack photo, then
     * their Google photo.
     */
    avatarUrl: z.string().optional(),
    email: z.string().optional(),
    fullName: z.string().optional(),
    slackUserId: z.string().optional(),
    slackUserName: z.string().optional(),
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
    /** Message id of the run's trigger input, which is not from a person. */
    triggerMessageId: z.string().min(1).optional(),
    /** Short trigger text, such as an event or a schedule. */
    triggerLabel: z.string().min(1).optional(),
    /** Credential mode this run used. Unset when the run record is gone. */
    credentialMode: z.enum(["creator", "system"]).optional(),
    /** Name of the creator whose credentials this run used. */
    credentialUser: z.string().min(1).optional(),
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

const conversationAnnotationReportSchema =
  conversationAnnotationInputSchema.and(
    z.object({
      plugin: z.string().min(1),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

export const conversationActivityPreviewSchema = z
  .object({
    createdAt: z.string().datetime(),
    mentions: z.array(actorIdentitySchema).optional(),
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1),
  })
  .strict();

export const conversationSummaryReportSchema = z
  .object({
    displayTitle: z.string(),
    activityPreview: conversationActivityPreviewSchema.optional(),
    cumulativeDurationMs: z.number(),
    cumulativeUsage: conversationUsageSchema.optional(),
    auxiliaryCosts: conversationAuxiliaryCostsSchema.optional(),
    childAgentTotals: conversationChildAgentTotalsSchema.optional(),
    conversationId: z.string(),
    kind: conversationKindSchema,
    /** Present on Threads and Tasks. */
    parentConversationId: z.string().min(1).optional(),
    isParticipant: z.boolean(),
    visibility: z.enum(["private", "public"]).optional(),
    status: conversationReportStatusSchema,
    startedAt: z.string(),
    lastSeenAt: z.string(),
    lastProgressAt: z.string(),
    // Feed rows only: the newest Message that a reader would notice
    // (`refreshLastMessageAt`). The dashboard sorts and groups rows by it.
    lastMessageAt: z.string().datetime().optional(),
    surface: conversationSurfaceSchema,
    actorIdentity: actorIdentitySchema.optional(),
    participants: z.array(actorIdentitySchema).optional(),
    /**
     * When this Conversation was archived for everyone, or null. It shows
     * only while it and every ancestor are unarchived.
     */
    archivedAt: z.string().datetime().nullable().optional(),
    pinnedAt: z.string().datetime().nullable().optional(),
    /** The viewer's place in Pinned. Unset until they reorder their pins. */
    pinPosition: z.number().int().optional(),
    /**
     * True when the conversation is idle and Junior's latest reply that the
     * transcript shows is after the viewer's read position. Quiet replies do
     * not count. Opening the conversation does not move the position; reading
     * in it, replying, archiving, or Mark as read does.
     */
    unread: z.boolean().optional(),
    channel: z.string().optional(),
    channelName: z.string().optional(),
    channelNameRedacted: z.boolean().optional(),
    locationId: z.string().optional(),
    sentryTraceUrl: z.string().optional(),
    locationUrl: z.string().url().optional(),
    traceId: z.string().optional(),
    /**
     * Plugin-owned resource links for this conversation.
     * Present on the conversation feed when the viewer can see private content.
     * Clients must not fetch provider state while rendering these links.
     */
    annotations: z.array(conversationAnnotationReportSchema).optional(),
    /** Plugin-selected annotations for the compact conversation row. */
    sidebarAnnotations: z.array(conversationSidebarAnnotationSchema).optional(),
    assignedWork: z.boolean().optional(),
    finishedWorkAt: z.string().datetime().optional(),
    /**
     * Dashboard Priority membership for this conversation summary.
     * Present on the conversation feed. Clients must not recompute it.
     *
     * True only when:
     * - unfinished work was last seen within 48 hours
     * - finished assigned work has conversation activity after the finish time
     * - there is no known work and the conversation was last seen within 3 hours
     */
    isPriority: z.boolean().optional(),
    unfinishedWork: z.boolean().optional(),
    /**
     * True on the conversation feed when a Turn in the conversation or a
     * child waits on a person to finish an authorization that has not
     * expired.
     */
    awaitingAuthorization: z.boolean().optional(),
  })
  .strict();

/** One Event listed on a message that holds several Events. */
export const conversationReportMessageEventSchema = z
  .object({
    eventType: z.string().min(1),
    label: z.string().min(1).optional(),
    objectType: objectTypeSchema.optional(),
    trustedSummary: z.string().min(1).optional(),
  })
  .strict();

const conversationReportMessageEventDataSchema = z
  .object({
    type: z.literal("message"),
    messageId: z.string().min(1),
    role: z.enum(["assistant", "system", "user"]),
    source: z.enum(["slack", "web"]).optional(),
    actorIdentity: actorIdentitySchema.optional(),
    /** Identity id of the author. Detail `authors` maps it to the person. */
    actorIdentityId: z.string().min(1).optional(),
    /** Agent invocation whose input this is. An agent wrote it, not a person. */
    agentInvocationId: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    /** Namespace of the first Event, such as `github`. */
    eventNamespace: z.string().min(1).optional(),
    eventObjectType: objectTypeSchema.optional(),
    explicitMention: z.boolean().optional(),
    quiet: z.literal(true).optional(),
    trustedSummary: z.string().min(1).optional(),
    /**
     * The Watch Events when several arrived together. A message that also
     * records Review item changes lists its own Event here even when it has
     * one.
     */
    events: z.array(conversationReportMessageEventSchema).optional(),
    cards: z.array(messageCardRefSchema).optional(),
    /** Person changes to Review items that this message records. */
    reviewItemChanges: z.array(reviewItemChangeRecordSchema).min(1).optional(),
    text: z.string().optional(),
    attachments: z.array(messageAttachmentSchema).optional(),
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
    if (
      data.redacted &&
      (data.actorIdentity ||
        data.cards ||
        data.attachments ||
        data.events ||
        data.reviewItemChanges)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "redacted messages must not expose actor identity, cards, attachments, events, or review item changes",
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
    parts: z.array(conversationReportReasoningPartSchema),
  })
  .strict();

const conversationReportTurnLifecycleEventDataSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        type: z.literal("turn_lifecycle"),
        turnId: z.string().min(1),
        state: z.enum(["succeeded", "no_reply", "blocked"]),
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
        failureCode: conversationTurnFailureCodeSchema,
        failureReason: conversationTurnFailureReasonSchema.optional(),
        eventId: z
          .string()
          .regex(/^[a-f0-9]{32}$/i)
          .optional(),
        sentryEventUrl: z.string().url().optional(),
      })
      .strict(),
  ],
);

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

const conversationReportAttachmentsDeliveredEventDataSchema = z
  .object({
    type: z.literal("attachments_delivered"),
    attachments: z.array(messageAttachmentSchema).min(1),
  })
  .strict();

/** Junior text that a plugin tool posted to its provider. */
const conversationReportReplyPostedEventDataSchema = z
  .object({
    type: z.literal("reply_posted"),
    plugin: z.string().min(1),
    text: z.string().min(1),
    url: z.string().url().optional(),
  })
  .strict();

const conversationReportCompactionEventDataSchema = z
  .object({
    type: z.literal("compaction"),
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

const conversationReportSubagentEventDataSchema = z
  .object({
    type: z.literal("subagent"),
    startedSeq: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    childConversationId: z.string().min(1),
    /** The child's Conversation kind. Only a Thread has its own page link. */
    childKind: z.enum(["thread", "task"]),
    subagentKind: z.string().min(1),
    agentName: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    parentToolCallId: z.string().min(1).optional(),
    status: z.enum(["running", "completed", "blocked", "error", "aborted"]),
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
  conversationReportAttachmentsDeliveredEventDataSchema,
  conversationReportReplyPostedEventDataSchema,
  conversationReportGuardianActionReviewedEventDataSchema,
  conversationReportCompactionEventDataSchema,
  conversationReportSubagentEventDataSchema,
]);

/** One ordered, privacy-safe canonical event projected for API consumers. */
export const conversationReportEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    data: conversationReportEventDataSchema,
    /** People mentioned in the event text, resolved at read time. */
    mentions: z.array(actorIdentitySchema).optional(),
    model: z
      .object({
        modelId: z.string().min(1),
      })
      .strict()
      .optional(),
    modelCall: z
      .object({
        provider: z.string().min(1).optional(),
        api: z.string().min(1).optional(),
        stopReason: z.string().min(1).optional(),
        usage: conversationUsageSchema.optional(),
      })
      .strict()
      .optional(),
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

export const forkConversationBodySchema = z
  .object({
    /** Assistant reply that ends the copied history. */
    messageId: z.string().min(1).max(500),
    idempotencyKey: z.string().trim().min(1).max(200),
    /** Start a hidden, read-only Quick question about this reply text. */
    quickQuestion: z
      .object({ quote: z.string().trim().min(1).max(4_000) })
      .strict()
      .optional(),
  })
  .strict();

export const forkConversationResponseSchema = z
  .object({ conversationId: z.string() })
  .strict();

/** One Conversation in the agent tree of a child Conversation. */
export const conversationAgentTreeNodeSchema = z
  .object({
    conversationId: z.string().min(1),
    kind: conversationKindSchema,
    label: z.string().min(1),
  })
  .strict();

export type ConversationAgentTreeNode = z.infer<
  typeof conversationAgentTreeNodeSchema
>;

export const conversationEventPageSchema = z
  .object({
    events: z.array(conversationReportEventSchema),
    eventHistory: conversationEventHistorySchema,
    previousCursor: z.string().min(1).optional(),
    /** Present on `after` and `around` pages when newer events follow. */
    nextCursor: z.string().min(1).optional(),
    generatedAt: z.string(),
  })
  .strict()
  .superRefine(validateConversationEvents);

/**
 * Carries the detail version token in both directions. A custom header, not
 * `ETag` / `If-None-Match`: in production the Vercel CDN answered standard
 * validators itself, after the function had already built the full report.
 */
export const CONVERSATION_DETAIL_VERSION_HEADER = "x-junior-detail-version";

/**
 * Carries the change token of the Conversation tree that a detail report was
 * built from. The dashboard compares it with the token of `GET /api/versions`
 * and asks for the report only when they differ.
 */
export const CONVERSATION_VERSION_HEADER = "x-junior-conversation-version";

export const conversationDetailReportSchema = conversationSummaryReportSchema
  .extend({
    /**
     * The parent chain of a child Conversation, root first, with this
     * Conversation last. Root Conversations omit it.
     */
    agentTree: z.array(conversationAgentTreeNodeSchema).min(2).optional(),
    /** The viewer's effective auto-archive choice. Participants only. */
    autoArchive: z.boolean().optional(),
    /** The viewer can fork this conversation from an assistant reply. */
    canFork: z.boolean().optional(),
    /** The viewer can move this dashboard conversation to a Slack thread. */
    canContinueInSlack: z.literal(true).optional(),
    /**
     * Event Turn replies stay out of the Location. Set only for a root with
     * a Location, when the viewer is a participant, who can change it.
     */
    deliveryPaused: z.boolean().optional(),
    /**
     * The viewer gets this conversation in their active feed. Participants
     * only. False after an unsubscribe, until they mention Junior again.
     */
    subscribed: z.boolean().optional(),
    /** How far the signed-in viewer has read. Absent until they read. */
    readPosition: conversationReadPositionSchema.optional(),
    /**
     * Pass as `after` to the events API to read from the read position.
     * Present only when unread events start before `events`.
     */
    unreadCursor: z.string().min(1).optional(),
    /**
     * The `around` page of `unreadCursor`, when the request asks for it. A
     * reader who opens at the read position needs no second request.
     */
    unreadPage: conversationEventPageSchema.optional(),
    forkedFromConversationId: z.string().optional(),
    /** Title of the fork source, when the viewer can open it. */
    forkedFromTitle: z.string().optional(),
    forks: z.array(z.string()).optional(),
    brief: z
      .object({
        content: conversationBriefSchema,
        /** People mentioned in the Brief text, resolved at read time. */
        mentions: z.array(actorIdentitySchema).optional(),
        updatedAt: z.string().datetime(),
        version: z.number().int().positive(),
      })
      .strict()
      .optional(),
    modelUsage: z.array(conversationModelUsageSchema).optional(),
    /**
     * Each person who wrote in the Conversation, by each of their Identity
     * ids. Messages and pending messages name their author with
     * `actorIdentityId`.
     */
    authors: z.record(z.string(), actorIdentitySchema).optional(),
    events: z.array(conversationReportEventSchema),
    /**
     * Events hold only the events after the request's `after` cursor. The
     * report omits `previousCursor` and `unreadCursor`: the reader keeps its
     * own.
     */
    appended: z.literal(true).optional(),
    /**
     * Pass as `after` on the next detail read to get only newer events.
     * Absent after a purge.
     */
    appendCursor: z.string().min(1).optional(),
    eventHistory: conversationEventHistorySchema,
    previousCursor: z.string().min(1).optional(),
    generatedAt: z.string(),
    sentryConversationUrl: z.string().optional(),
    sourceTask: conversationSourceTaskSchema.optional(),
  })
  .strict()
  .superRefine(validateConversationEvents);

export type ConversationReportStatus = z.infer<
  typeof conversationReportStatusSchema
>;
export type ConversationTurnFailureCode = z.infer<
  typeof conversationTurnFailureCodeSchema
>;
export type ConversationTurnFailureReason = z.infer<
  typeof conversationTurnFailureReasonSchema
>;
export type ConversationSurface = z.infer<typeof conversationSurfaceSchema>;
export type ConversationCost = z.infer<typeof conversationCostSchema>;
export type ConversationUsage = z.infer<typeof conversationUsageSchema>;
export type ConversationAuxiliaryCosts = z.infer<
  typeof conversationAuxiliaryCostsSchema
>;
export type ActorIdentity = z.infer<typeof actorIdentitySchema>;
export type ConversationActivityPreview = z.infer<
  typeof conversationActivityPreviewSchema
>;
export type ConversationSummaryReport = z.infer<
  typeof conversationSummaryReportSchema
>;
export type ConversationModelUsage = z.infer<
  typeof conversationModelUsageSchema
>;
export type ConversationReportMessageEvent = z.infer<
  typeof conversationReportMessageEventSchema
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
export type ConversationParams = z.infer<typeof conversationParamsSchema>;
export type ForkConversationBody = z.infer<typeof forkConversationBodySchema>;
export type CreateConversationBody = z.infer<
  typeof createConversationBodySchema
>;
export type CreateConversationMessageBody = z.infer<
  typeof createConversationMessageBodySchema
>;
export type AcceptedConversationMessage = z.infer<
  typeof acceptedConversationMessageSchema
>;
