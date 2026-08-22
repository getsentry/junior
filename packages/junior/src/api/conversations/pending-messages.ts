import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getConversationStore, getDb } from "@/chat/db";
import { lookupSlackUser } from "@/chat/slack/user";
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
import { webActorFromEmail } from "@/chat/api-turns/work";
import { getWebAuthorization } from "@/chat/api-turns/authorization";

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
    ...(metadata.authorFullName ? { fullName: metadata.authorFullName } : undefined),
  };
}

async function actorIdentityFromSlackMetadata(
  metadata: z.output<typeof slackMailboxMetadataSchema>,
  teamId: string | undefined,
): Promise<ActorIdentity | undefined> {
  if (metadata.message.author.isMe === true) return undefined;
  const slackUserId = metadata.message.author.userId.trim();
  if (!slackUserId) return undefined;
  const profile = teamId ? await lookupSlackUser(teamId, slackUserId) : null;
  const slackUserName =
    profile?.userName?.trim() || metadata.message.author.userName?.trim();
  const fullName =
    profile?.fullName?.trim() || metadata.message.author.fullName?.trim();
  const email = profile?.email?.trim().toLowerCase();
  return {
    slackUserId,
    ...(slackUserName ? { slackUserName } : undefined),
    ...(fullName ? { fullName } : undefined),
    ...(email ? { email } : undefined),
  };
}

async function projectPendingMessage(
  message: InboundMessage,
  canExposePayload: boolean,
): Promise<ConversationPendingMessage | undefined> {
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
    if (!canExposePayload) {
      return {
        createdAt: isoFromMs(message.createdAtMs),
        delivery: message.delivery,
        inboundMessageId: message.inboundMessageId,
        messageId: metadata.data.message.id,
        receivedAt: isoFromMs(message.receivedAtMs),
        redacted: true,
        role: "user",
        source: "slack",
      };
    }
    const actorIdentity = await actorIdentityFromSlackMetadata(
      metadata.data,
      message.destination?.platform === "slack"
        ? message.destination.teamId
        : undefined,
    );
    return {
      createdAt: isoFromMs(message.createdAtMs),
      delivery: message.delivery,
      inboundMessageId: message.inboundMessageId,
      messageId: metadata.data.message.id,
      receivedAt: isoFromMs(message.receivedAtMs),
      role: "user",
      source: "slack",
      ...(actorIdentity ? { actorIdentity } : undefined),
      text,
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
    await readConversationAccessFromSql(
      getDb(),
      [conversationId],
      options.viewer,
    )
  ).get(conversationId);
  const canExposePayload = access?.canViewPrivateContent ?? false;
  const isParticipant = access?.isParticipant ?? false;
  const actorId = options.viewer?.email
    ? webActorFromEmail(options.viewer.email).userId
    : undefined;
  const authorization =
    isParticipant && actorId
      ? await getWebAuthorization({ actorId, conversationId })
      : undefined;

  const work = await getConversation({ conversationId });
  const projectedMessages = await Promise.all(
    (work?.execution.pendingMessages ?? []).map((message) =>
      projectPendingMessage(message, canExposePayload),
    ),
  );
  const messages = projectedMessages.filter(
    (message): message is ConversationPendingMessage => Boolean(message),
  );

  return conversationPendingMessagesReportSchema.parse({
    ...(authorization
      ? {
          authorization: {
            authorizationUrl: authorization.authorizationUrl,
            completionText: authorization.completionText,
            label: authorization.label,
          },
        }
      : undefined),
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
