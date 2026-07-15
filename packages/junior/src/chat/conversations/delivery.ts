import { z } from "zod";
import {
  actorSchema,
  slackDestinationSchema,
  slackSourceSchema,
} from "@sentry/junior-plugin-api";
import { agentTurnUsageSchema } from "@/chat/usage";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import { conversationModelMessageSchema } from "./model-message";
import { conversationTurnFailureCodeSchema } from "./turn-failure";

/** Stable identifier shared by delivery control state and canonical facts. */
export const conversationDeliveryIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:_-]+$/);

/** Allowlisted destination provider for durable delivery facts. */
export const conversationDeliveryProviderSchema = z.literal("slack");

/** Delivery family currently owned by the durable Slack reply boundary. */
export const conversationDeliveryKindSchema = z.literal("assistant_reply");

/** Privacy-safe reason that an intended delivery cannot be completed. */
export const conversationDeliveryFailureCodeSchema =
  z.literal("provider_rejected");

const slackMrkdwnTextSchema = z
  .object({ type: z.literal("mrkdwn"), text: z.string() })
  .strict();

const durableSlackBlockSchema = z.union([
  z.object({ type: z.literal("markdown"), text: z.string() }).strict(),
  z
    .object({ type: z.literal("section"), text: slackMrkdwnTextSchema })
    .strict(),
  z
    .object({
      type: z.literal("context"),
      elements: z.array(slackMrkdwnTextSchema).min(1),
    })
    .strict(),
]);

const durableDeliveryPartSchema = z
  .object({
    partId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9:_-]+$/),
    stage: z.enum(["thread_reply", "thread_reply_continuation"]),
    text: z.string().min(1).max(40_000),
    blocks: z.array(durableSlackBlockSchema).min(1).optional(),
  })
  .strict();

/**
 * Immutable command needed to finish one Slack assistant reply without
 * rerunning the model. This deliberately excludes private authorization
 * delivery, arbitrary Slack metadata, credentials, and provider responses.
 */
export const pendingConversationDeliveryCommandSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("slack"),
    deliveryKind: z.literal("assistant_reply"),
    route: z
      .object({
        channelId: z.string().regex(/^[CDG][A-Z0-9]+$/),
        threadTs: z.string().regex(/^\d+(?:\.\d+)?$/),
      })
      .strict(),
    publicLocator: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    session: z
      .object({
        surface: z.literal("slack"),
        source: slackSourceSchema,
        destination: slackDestinationSchema,
        destinationVisibility: z.enum(["public", "private"]).optional(),
        actor: actorSchema.optional(),
        channelName: z.string().min(1).optional(),
        startedAtMs: z.number().finite(),
      })
      .strict(),
    parts: z.array(durableDeliveryPartSchema).min(1),
    completion: z
      .object({
        inputMessageIds: z.array(z.string().min(1)).min(1),
        assistantMessage: z
          .object({
            messageId: z.string().min(1),
            text: z.string(),
            createdAtMs: z.number().finite(),
            author: z
              .object({ userName: z.string().min(1), isBot: z.literal(true) })
              .strict(),
          })
          .strict(),
        turnId: z.string().min(1),
        model: z
          .object({
            modelId: z.string().min(1),
            messages: z.array(conversationModelMessageSchema),
          })
          .strict(),
        durationMs: z.number().int().nonnegative().optional(),
        usage: agentTurnUsageSchema.optional(),
        reasoningLevel: z.string().min(1).optional(),
        sliceId: z.number().int().positive(),
        terminal: z.discriminatedUnion("outcome", [
          z.object({ outcome: z.literal("success") }).strict(),
          z
            .object({
              outcome: z.literal("failed"),
              failureCode: conversationTurnFailureCodeSchema,
              eventId: z
                .string()
                .regex(/^[a-f0-9]{32}$/i)
                .optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict()
  .superRefine((command, ctx) => {
    const partIds = command.parts.map((part) => part.partId);
    if (new Set(partIds).size !== partIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "delivery part ids must be unique",
        path: ["parts"],
      });
    }
    if (
      new Set(command.completion.inputMessageIds).size !==
      command.completion.inputMessageIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "delivery input message ids must be unique",
        path: ["completion", "inputMessageIds"],
      });
    }
    if (
      command.completion.assistantMessage.messageId !==
      buildDeterministicAssistantMessageId(command.completion.turnId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "delivery assistant message id must match its turn",
        path: ["completion", "assistantMessage", "messageId"],
      });
    }
    const sourceThreadTs =
      command.session.source.threadTs ?? command.session.source.messageTs;
    if (
      command.route.channelId !== command.session.source.channelId ||
      command.route.channelId !== command.session.destination.channelId ||
      command.session.source.teamId !== command.session.destination.teamId ||
      command.route.threadTs !== sourceThreadTs
    ) {
      ctx.addIssue({
        code: "custom",
        message: "delivery route and session coordinates must match",
        path: ["route"],
      });
    }
  });

/** Exact validated command retained only while delivery is unresolved. */
export type PendingConversationDeliveryCommand = z.output<
  typeof pendingConversationDeliveryCommandSchema
>;

const pendingPartStateSchema = z
  .object({ status: z.literal("pending") })
  .strict();
const postingPartStateSchema = z
  .object({
    status: z.literal("posting"),
    startedAtMs: z.number().finite(),
  })
  .strict();
const acceptedPartStateSchema = z
  .object({
    status: z.literal("accepted"),
    providerMessageId: z.string().regex(/^\d+(?:\.\d+)?$/),
    acceptedAtMs: z.number().finite(),
  })
  .strict();
const uncertainPartStateSchema = z
  .object({
    status: z.literal("uncertain"),
    attemptedAtMs: z.number().finite(),
    retryAtMs: z.number().finite(),
    reconciliationAttempt: z.number().int().nonnegative(),
    reconciliationCursor: z.string().min(1).max(512).optional(),
    confirmedAbsentAtMs: z.number().finite().optional(),
  })
  .strict();
const failedPartStateSchema = z
  .object({
    status: z.literal("failed"),
    failureCode: conversationDeliveryFailureCodeSchema,
    failedAtMs: z.number().finite(),
  })
  .strict();

/** Mutable reconciliation state for one immutable command part. */
export const pendingConversationDeliveryPartStateSchema = z.union([
  pendingPartStateSchema,
  postingPartStateSchema,
  acceptedPartStateSchema,
  uncertainPartStateSchema,
  failedPartStateSchema,
]);

export type PendingConversationDeliveryPartState = z.output<
  typeof pendingConversationDeliveryPartStateSchema
>;

/** Validated per-part state keyed by immutable command part id. */
export const pendingConversationDeliveryPartStatesSchema = z.record(
  z.string().min(1),
  pendingConversationDeliveryPartStateSchema,
);
