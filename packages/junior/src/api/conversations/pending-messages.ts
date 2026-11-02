import { readMessageAttachments } from "@/chat/attachments/input";
import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { loadConversationSlackTenantIds } from "@/chat/conversations/sql/event-actor";
import { parseContent } from "@/chat/slack/message/content";
import { lookupSlackUser } from "@/chat/slack/user";
import {
  getConversation,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { throwApiError } from "../http";
import { resolveMentions } from "../mentions";
import {
  conversationPendingMessagesReportSchema,
  type ActorIdentity,
  type ConversationPendingMessage,
  type ConversationPendingMessagesReport,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { getWebAuthorization } from "@/chat/conversations/web-authorization";
import {
  legacyWebMailboxMetadataSchema,
  type LegacyWebMailboxMetadata,
} from "@/chat/conversations/web-mailbox";

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
    raw: z.unknown().optional(),
  })
  .passthrough();

const slackMailboxMetadataSchema = z
  .object({
    message: slackMailboxMessageSchema,
    platform: z.literal("slack"),
  })
  .passthrough();

/**
 * Project Slack text the way the Turn stores it in history. The SDK text
 * turns `<@U123>` into a bare `@U123` or `@name`, which the dashboard
 * cannot render as a mention.
 */
function slackDisplayText(
  message: z.output<typeof slackMailboxMessageSchema>,
  sdkText: string,
): string {
  return parseContent({
    attachments: [],
    formatted: { type: "root", children: [] },
    raw: message.raw,
    text: sdkText,
  }).text;
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function actorIdentityFromWebMetadata(
  metadata: LegacyWebMailboxMetadata,
): ActorIdentity {
  return {
    email: metadata.authorEmail.trim().toLowerCase(),
    ...(metadata.authorFullName
      ? { fullName: metadata.authorFullName }
      : undefined),
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
    const metadata = legacyWebMailboxMetadataSchema.safeParse(
      message.input.metadata,
    );
    if (!metadata.success) return undefined;
    const text = message.input.text.trim();
    const attachments = readMessageAttachments(message.input.attachments);
    if (!text && !attachments.length) return undefined;
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
            actorIdentity: actorIdentityFromWebMetadata(metadata.data),
            text,
            ...(attachments.length ? { attachments } : undefined),
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
    const text = slackDisplayText(
      metadata.data.message,
      message.input.text,
    ).trim();
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

async function attachPendingMentions(
  conversationId: string,
  messages: ConversationPendingMessage[],
): Promise<ConversationPendingMessage[]> {
  if (!messages.some((message) => message.text?.includes("<@"))) {
    return messages;
  }
  const executor = getSqlExecutor();
  const tenantId = (
    await loadConversationSlackTenantIds(executor, [conversationId])
  ).get(conversationId);
  const mentions = await resolveMentions(
    executor,
    messages.map((message) => ({ tenantId, texts: [message.text] })),
  );
  return messages.map((message, index) =>
    mentions[index]!.length > 0
      ? { ...message, mentions: mentions[index] }
      : message,
  );
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
  const pendingMessages = work?.execution.pendingMessages ?? [];
  const projectedMessages = await Promise.all(
    pendingMessages.map((message) =>
      projectPendingMessage(message, canExposePayload),
    ),
  );
  const messages = await attachPendingMentions(
    conversationId,
    projectedMessages.flatMap((message, index) => {
      if (!message) return [];
      const actorIdentityId = pendingMessages[index]!.input.authorIdentityId;
      return [
        canExposePayload && actorIdentityId
          ? { ...message, actorIdentityId }
          : message,
      ];
    }),
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
