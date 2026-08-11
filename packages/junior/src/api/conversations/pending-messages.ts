import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getConversationStore, getDb } from "@/chat/db";
import {
  getConversation,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { throwApiError } from "../http";
import {
  conversationPendingMessagesReportSchema,
  type ActorIdentity,
  type ConversationPendingMessage,
  type ConversationPendingMessagesReport,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

const apiTurnMailboxMetadataSchema = z
  .object({
    authorEmail: z.string().email(),
    authorFullName: z.string().min(1).optional(),
    authorUserId: z.string().min(1),
    authorUserName: z.string().min(1).optional(),
    kind: z.literal("api_turn"),
    messageId: z.string().min(1),
  })
  .strict();

const slackMailboxAuthorSchema = z
  .object({
    userId: z.string(),
    userName: z.string().optional(),
    fullName: z.string().optional(),
    isMe: z.boolean().optional(),
  })
  .passthrough();

const slackMailboxMessageSchema = z
  .object({
    author: slackMailboxAuthorSchema,
    id: z.string().min(1),
  })
  .passthrough();

const slackMailboxMetadataSchema = z
  .object({
    message: slackMailboxMessageSchema,
    platform: z.literal("slack"),
  })
  .passthrough();

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function actorIdentityFromApiMetadata(
  metadata: z.output<typeof apiTurnMailboxMetadataSchema>,
): ActorIdentity {
  return {
    email: metadata.authorEmail.trim().toLowerCase(),
    ...(metadata.authorFullName ? { fullName: metadata.authorFullName } : {}),
  };
}

function actorIdentityFromSlackMetadata(
  metadata: z.output<typeof slackMailboxMetadataSchema>,
): ActorIdentity | undefined {
  if (metadata.message.author.isMe === true) return undefined;
  const slackUserId = metadata.message.author.userId.trim();
  if (!slackUserId) return undefined;
  const slackUserName = metadata.message.author.userName?.trim();
  const fullName = metadata.message.author.fullName?.trim();
  return {
    slackUserId,
    ...(slackUserName ? { slackUserName } : {}),
    ...(fullName ? { fullName } : {}),
  };
}

function projectPendingMessage(
  message: InboundMessage,
  canExposePayload: boolean,
): ConversationPendingMessage | undefined {
  if (message.source === "web") {
    const metadata = apiTurnMailboxMetadataSchema.safeParse(
      message.input.metadata,
    );
    if (!metadata.success) return undefined;
    const text = message.input.text.trim();
    if (!text) return undefined;
    return {
      createdAt: isoFromMs(message.createdAtMs),
      delivery: message.delivery,
      inboundMessageId: message.inboundMessageId,
      messageId: metadata.data.messageId,
      receivedAt: isoFromMs(message.receivedAtMs),
      role: "user",
      source: "web",
      ...(canExposePayload
        ? {
            actorIdentity: actorIdentityFromApiMetadata(metadata.data),
            text,
          }
        : { redacted: true as const }),
    };
  }

  if (message.source === "slack") {
    const metadata = slackMailboxMetadataSchema.safeParse(
      message.input.metadata,
    );
    if (!metadata.success) return undefined;
    if (metadata.data.message.author.isMe === true) return undefined;
    const text = message.input.text.trim();
    if (!text) return undefined;
    const actorIdentity = actorIdentityFromSlackMetadata(metadata.data);
    return {
      createdAt: isoFromMs(message.createdAtMs),
      delivery: message.delivery,
      inboundMessageId: message.inboundMessageId,
      messageId: metadata.data.message.id,
      receivedAt: isoFromMs(message.receivedAtMs),
      role: "user",
      source: "slack",
      ...(canExposePayload
        ? {
            ...(actorIdentity ? { actorIdentity } : {}),
            text,
          }
        : { redacted: true as const }),
    };
  }

  return undefined;
}

/**
 * Read accepted mailbox messages that have not reached durable history yet.
 *
 * Returns only human-facing web and Slack rows. Internal mailbox work stays
 * hidden from the transcript.
 */
export async function readConversationPendingMessages(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationPendingMessagesReport | undefined> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) return undefined;

  const access = (
    await readConversationAccessFromSql(getDb(), [conversationId], options.viewer)
  ).get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;

  const work = await getConversation({ conversationId });
  const messages = (work?.execution.pendingMessages ?? [])
    .map((message) => projectPendingMessage(message, canExposePayload))
    .filter((message): message is ConversationPendingMessage =>
      Boolean(message),
    );

  return conversationPendingMessagesReportSchema.parse({
    conversationId,
    generatedAt: new Date().toISOString(),
    messages,
  });
}

/** Load pending mailbox messages or throw a standard API not-found error. */
export async function requireConversationPendingMessages(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationPendingMessagesReport> {
  const report = await readConversationPendingMessages(conversationId, options);
  if (!report) throwApiError(404, "Conversation not found.");
  return report;
}
