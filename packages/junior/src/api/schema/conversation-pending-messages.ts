import * as z from "zod";
import { messageAttachmentSchema } from "@/chat/attachments/input";
import { reviewItemChangeRecordSchema } from "@/chat/review-items/change-record";
import {
  actorIdentitySchema,
  conversationDetailReportSchema,
} from "./conversation";

/** Mailbox delivery mode for one accepted inbound message. */
export const conversationPendingMessageDeliverySchema = z.enum([
  "defer",
  "interrupt",
]);

/** One accepted mailbox message that has not reached durable history yet. */
export const conversationPendingMessageSchema = z
  .object({
    actorIdentity: actorIdentitySchema.optional(),
    /** Identity id of the author. Detail `authors` maps it to the person. */
    actorIdentityId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    delivery: conversationPendingMessageDeliverySchema,
    inboundMessageId: z.string().min(1),
    messageId: z.string().min(1),
    receivedAt: z.string().datetime(),
    role: z.literal("user"),
    source: z.enum(["slack", "web"]),
    text: z.string().optional(),
    /** People mentioned in the text, resolved at read time. */
    mentions: z.array(actorIdentitySchema).optional(),
    attachments: z.array(messageAttachmentSchema).optional(),
    /** Review item change that this Message records. */
    reviewItemChange: reviewItemChangeRecordSchema.optional(),
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
    if (
      data.redacted &&
      (data.actorIdentity ||
        data.attachments ||
        data.mentions ||
        data.reviewItemChange)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "redacted pending messages must not expose actor identity, attachments, mentions, or a review item",
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

/** Detail report with the mailbox that was read before its history. */
export const conversationDetailWithMailboxReportSchema =
  conversationDetailReportSchema.extend({
    mailbox: conversationPendingMessagesReportSchema,
  });

/**
 * Answer to a `mailbox=true` poll whose detail version still matches. The
 * client keeps its cached detail and takes the new mailbox.
 */
export const conversationUnchangedDetailWithMailboxSchema = z
  .object({
    mailbox: conversationPendingMessagesReportSchema,
    unchanged: z.literal(true),
  })
  .strict();

/** Optional filters for cancelling accepted mailbox rows. */
export const cancelConversationPendingMessagesBodySchema = z
  .object({
    inboundMessageIds: z.array(z.string().min(1)).min(1).optional(),
    receivedBefore: z.string().datetime().optional(),
  })
  .strict();

/** Result of cancelling accepted human-facing mailbox rows. */
export const cancelConversationPendingMessagesResponseSchema = z
  .object({
    cancelledCount: z.number().int().nonnegative(),
    cancelledInboundMessageIds: z.array(z.string().min(1)),
    conversationId: z.string().min(1),
  })
  .strict();

/** Queued web messages that the viewer wants Junior to read now. */
export const steerConversationPendingMessagesBodySchema = z
  .object({ inboundMessageIds: z.array(z.string().min(1)).min(1) })
  .strict();

/** Result of steering queued web messages into the conversation. */
export const steerConversationPendingMessagesResponseSchema = z
  .object({
    conversationId: z.string().min(1),
    steeredInboundMessageIds: z.array(z.string().min(1)),
  })
  .strict();

export type ConversationPendingMessageDelivery = z.infer<
  typeof conversationPendingMessageDeliverySchema
>;
export type ConversationPendingMessage = z.infer<
  typeof conversationPendingMessageSchema
>;
export type ConversationPendingMessagesReport = z.infer<
  typeof conversationPendingMessagesReportSchema
>;
export type CancelConversationPendingMessagesBody = z.infer<
  typeof cancelConversationPendingMessagesBodySchema
>;
export type CancelConversationPendingMessagesResponse = z.infer<
  typeof cancelConversationPendingMessagesResponseSchema
>;
export type SteerConversationPendingMessagesBody = z.infer<
  typeof steerConversationPendingMessagesBodySchema
>;
export type SteerConversationPendingMessagesResponse = z.infer<
  typeof steerConversationPendingMessagesResponseSchema
>;
