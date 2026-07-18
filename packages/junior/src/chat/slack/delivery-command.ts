/** Exact persisted command and progress schemas for recoverable Slack replies. */
import { z } from "zod";
import {
  actorSchema,
  slackDestinationSchema,
  sourceSchema,
} from "@sentry/junior-plugin-api";
import { agentTurnUsageSchema } from "@/chat/usage";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";
import { conversationTurnFailureCodeSchema } from "@/chat/conversations/turn-failure";
import type { AgentTurnDiagnostics } from "@/chat/services/turn-result";
import {
  buildSlackReplyBlocks,
  type SlackReplyFooter,
} from "@/chat/slack/footer";

/** Stable identifier shared by delivery control state and canonical facts. */
export const conversationDeliveryIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:_-]+$/);

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
    route: z
      .object({
        channelId: z.string().regex(/^[CDG][A-Z0-9]+$/),
        threadTs: z
          .string()
          .regex(/^\d+(?:\.\d+)?$/)
          .optional(),
      })
      .strict(),
    publicLocator: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    session: z
      .object({
        surface: z.enum(["slack", "api"]),
        source: sourceSchema,
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
            committedSeq: z.number().int().min(-1),
            rollbackSeq: z.number().int().min(-1),
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
    if (
      command.completion.model.rollbackSeq >
      command.completion.model.committedSeq
    ) {
      ctx.addIssue({
        code: "custom",
        message: "delivery rollback cursor cannot exceed its commit cursor",
        path: ["completion", "model", "rollbackSeq"],
      });
    }
    if (command.route.channelId !== command.session.destination.channelId) {
      ctx.addIssue({
        code: "custom",
        message: "delivery route must match the session destination",
        path: ["route"],
      });
    }
  });

/** Exact validated command retained only while delivery is unresolved. */
export type PendingConversationDeliveryCommand = z.output<
  typeof pendingConversationDeliveryCommandSchema
>;

/** Delivery command before canonical model-event cursors are assigned. */
export type PendingConversationDeliveryCommandDraft = Omit<
  PendingConversationDeliveryCommand,
  "completion"
> & {
  completion: Omit<
    PendingConversationDeliveryCommand["completion"],
    "model"
  > & {
    model: { modelId: string };
  };
};

export interface BuildPendingSlackDeliveryCommandDraftArgs {
  assistantCreatedAtMs: number;
  assistantText: string;
  assistantUserName: string;
  diagnostics: AgentTurnDiagnostics;
  failureEventId?: string;
  footer?: SlackReplyFooter;
  inputMessageIds: string[];
  posts: readonly { text: string }[];
  publicLocator: string;
  route: PendingConversationDeliveryCommandDraft["route"];
  session: PendingConversationDeliveryCommandDraft["session"];
  sliceId: number;
  turnId: string;
}

/** Build the shared persisted command for one finalized Slack reply. */
export function buildPendingSlackDeliveryCommandDraft(
  args: BuildPendingSlackDeliveryCommandDraftArgs,
): PendingConversationDeliveryCommandDraft {
  return {
    publicLocator: args.publicLocator,
    route: args.route,
    session: args.session,
    parts: args.posts.map((post, index) => {
      const blocks = buildSlackReplyBlocks(
        post.text,
        index === args.posts.length - 1 ? args.footer : undefined,
      );
      return {
        text: post.text,
        ...(blocks ? { blocks } : {}),
      };
    }),
    completion: {
      turnId: args.turnId,
      inputMessageIds: args.inputMessageIds,
      assistantMessage: {
        messageId: buildDeterministicAssistantMessageId(args.turnId),
        text: args.assistantText,
        createdAtMs: args.assistantCreatedAtMs,
        author: { userName: args.assistantUserName, isBot: true },
      },
      model: { modelId: args.diagnostics.modelId },
      ...(args.diagnostics.durationMs !== undefined
        ? { durationMs: args.diagnostics.durationMs }
        : {}),
      ...(args.diagnostics.usage ? { usage: args.diagnostics.usage } : {}),
      ...(args.diagnostics.reasoningLevel
        ? { reasoningLevel: args.diagnostics.reasoningLevel }
        : {}),
      sliceId: args.sliceId,
      terminal:
        args.diagnostics.outcome === "success"
          ? { outcome: "success" }
          : {
              outcome: "failed",
              failureCode: "model_execution_failed",
              ...(args.failureEventId ? { eventId: args.failureEventId } : {}),
            },
    },
  };
}

const pendingDeliveryReadyStateSchema = z
  .object({ status: z.literal("pending") })
  .strict();
const pendingDeliveryPostingStateSchema = z
  .object({
    status: z.literal("posting"),
    attemptedAtMs: z.number().finite(),
  })
  .strict();
const pendingDeliveryUncertainStateSchema = z
  .object({
    status: z.literal("uncertain"),
    attemptedAtMs: z.number().finite(),
    reconciliationCursor: z.string().min(1).max(512).optional(),
    confirmedAbsentAtMs: z.number().finite().optional(),
  })
  .strict();
const pendingDeliveryFailedStateSchema = z
  .object({
    status: z.literal("failed"),
    failureCode: conversationDeliveryFailureCodeSchema,
  })
  .strict();

/** Mutable state for the current ordered delivery part. */
export const pendingConversationDeliveryCurrentStateSchema = z.union([
  pendingDeliveryReadyStateSchema,
  pendingDeliveryPostingStateSchema,
  pendingDeliveryUncertainStateSchema,
  pendingDeliveryFailedStateSchema,
]);

export type PendingConversationDeliveryCurrentState = z.output<
  typeof pendingConversationDeliveryCurrentStateSchema
>;

/** Accepted part count plus the mutable state of the next ordered part. */
export const pendingConversationDeliveryProgressSchema = z
  .object({
    acceptedPartCount: z.number().int().nonnegative(),
    acceptedMessageTs: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)).default([]),
    currentState: pendingConversationDeliveryCurrentStateSchema,
  })
  .strict()
  .refine(
    (progress) =>
      progress.acceptedMessageTs.length === progress.acceptedPartCount,
    "accepted Slack receipts must align with accepted parts",
  );

export type PendingConversationDeliveryProgress = z.output<
  typeof pendingConversationDeliveryProgressSchema
>;
