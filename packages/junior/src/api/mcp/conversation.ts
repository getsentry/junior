/** Own the MCP view of one Conversation, shared by the conversation tools. */
import * as z from "zod";
import {
  conversationReportStatusSchema,
  conversationSurfaceSchema,
  type ActorIdentity,
  type ConversationReportEvent,
  type ConversationSummaryReport,
} from "@/api/schema/conversation";
import type { MessageAttachment } from "@/chat/attachments/input";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { logException } from "@/chat/logging";
import type { User } from "@sentry/junior-plugin-api";
import { readConversationPendingMessages } from "@/api/conversations/pending-messages";
import { conversationPendingMessageDeliverySchema } from "@/api/schema/conversation-pending-messages";

/** MCP view of one Conversation. It omits dashboard-only fields. */
export const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    status: conversationReportStatusSchema.describe(
      "`active` while work runs, waits to start, or waits on you. `completed` when no work is left. `failed` when the last turn failed.",
    ),
    surface: conversationSurfaceSchema.describe(
      "Where it started: `slack`, `api` (the dashboard or MCP), `scheduler` (an automation), or `internal`.",
    ),
    channelName: z.string().optional().describe("Slack channel name."),
    locationUrl: z.string().optional().describe("Slack thread link."),
    startedAt: z.string(),
    lastSeenAt: z
      .string()
      .describe(
        "Time of the newest activity. archiveConversation takes this value.",
      ),
    archivedAt: z
      .string()
      .optional()
      .describe("Set when you archived it, or when anyone archived a Thread."),
    pinnedAt: z.string().optional().describe("Set when you pinned it."),
    url: z.string().optional().describe("Dashboard link."),
  })
  .strict();

type McpConversation = z.output<typeof mcpConversationSchema>;

/** Map a Conversation summary to its MCP view. */
export function mcpConversation(
  summary: ConversationSummaryReport,
): McpConversation {
  return {
    conversationId: summary.conversationId,
    title: summary.displayTitle,
    status: summary.status,
    surface: summary.surface,
    channelName: summary.channelNameRedacted ? undefined : summary.channelName,
    locationUrl: summary.locationUrl,
    startedAt: summary.startedAt,
    lastSeenAt: summary.lastSeenAt,
    archivedAt:
      (summary.kind !== "root"
        ? summary.childArchivedAt
        : summary.archivedAt) ?? undefined,
    pinnedAt: summary.pinnedAt ?? undefined,
    url: getDashboardConversationLink(summary.conversationId),
  };
}

/** Conversation id param shared by the conversation tools. */
export const mcpConversationIdSchema = z
  .string()
  .min(1)
  .describe("Conversation id from searchConversations or createConversation.");

const mcpAttachmentsSchema = z
  .array(
    z
      .object({
        filename: z.string(),
        contentType: z.string(),
        bytes: z.number().int(),
      })
      .strict(),
  )
  .optional();

function mcpAttachments(
  attachments: readonly MessageAttachment[] | undefined,
): z.output<typeof mcpAttachmentsSchema> {
  return attachments?.length
    ? attachments.map(({ bytes, contentType, filename }) => ({
        bytes,
        contentType,
        filename,
      }))
    : undefined;
}

function mcpAuthor(identity: ActorIdentity | undefined): string | undefined {
  return identity?.fullName ?? identity?.slackUserName ?? identity?.email;
}

/** MCP view of one user or assistant Message. */
export const mcpMessageSchema = z
  .object({
    seq: z
      .number()
      .int()
      .describe(
        "Position in the transcript. markConversationRead takes this value.",
      ),
    messageId: z
      .string()
      .describe(
        "For a message that you sent, the `messageId` that sendMessage or createConversation returned.",
      ),
    createdAt: z.string(),
    role: z.enum(["assistant", "user"]),
    author: z.string().optional(),
    text: z.string(),
    attachments: mcpAttachmentsSchema,
  })
  .strict();

/** One user or assistant Message in an MCP result. */
export type McpMessage = z.output<typeof mcpMessageSchema>;

/**
 * Keep the user and assistant Messages of a report event page, in order.
 * System Messages and Messages with no text or attachment are left out.
 */
export function mcpMessages(
  events: readonly ConversationReportEvent[],
): McpMessage[] {
  return events.flatMap((event) => {
    const data = event.data;
    if (data.type !== "message" || data.role === "system") return [];
    const text = data.text ?? "";
    const attachments = mcpAttachments(data.attachments);
    if (!text && !attachments) return [];
    const author = mcpAuthor(data.actorIdentity);
    return [
      {
        seq: event.seq,
        messageId: data.messageId,
        createdAt: event.createdAt,
        role: data.role,
        ...(author ? { author } : undefined),
        text,
        ...(attachments ? { attachments } : undefined),
      },
    ];
  });
}

/** Message text param shared by the tools that send a message. */
export const mcpMessageTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(32_000)
  .describe("Message text.");

/**
 * Idempotency key param shared by the tools that send a message. A retry
 * with the same key sends nothing new.
 */
export const mcpIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Reuse the same key to retry without sending the message twice. Omit it to send a new message.",
  );

/**
 * MCP view of one accepted user Message that no Turn has read yet. It is not
 * in the transcript, so it has no `seq`.
 */
const mcpPendingMessageSchema = z
  .object({
    messageId: z.string(),
    createdAt: z.string(),
    author: z.string().optional(),
    text: z.string(),
    attachments: mcpAttachmentsSchema,
    delivery: conversationPendingMessageDeliverySchema.describe(
      "`defer` waits for the running turn to end. `interrupt` joins the running turn at its next safe step.",
    ),
  })
  .strict();

/** Pending Messages field shared by `getConversation` and the send tools. */
export const mcpPendingMessagesSchema = z
  .array(mcpPendingMessageSchema)
  .describe(
    "Accepted messages that no turn has read yet, oldest first. A message leaves this list when a turn reads it.",
  );

/** Authorization that a parked Turn waits for. */
export const mcpAuthorizationSchema = z
  .object({
    label: z.string(),
    url: z.string(),
  })
  .strict()
  .describe(
    "Set when a turn waits for you to connect an account. Open `url` in a browser to continue.",
  );

type McpPendingWork = {
  pendingMessages: z.output<typeof mcpPendingMessagesSchema>;
  authorization?: z.output<typeof mcpAuthorizationSchema>;
};

/**
 * Read the Messages that wait for a Turn and the authorization that a parked
 * Turn waits for. The caller must check that `user` is a participant.
 */
export async function readMcpPendingWork(
  user: User,
  conversationId: string,
): Promise<McpPendingWork> {
  const report = await readConversationPendingMessages(conversationId, {
    viewer: user,
  });
  const pendingMessages = (report?.messages ?? []).flatMap((message) => {
    if (message.text === undefined) return [];
    const author = mcpAuthor(message.actorIdentity);
    const attachments = mcpAttachments(message.attachments);
    return [
      {
        messageId: message.messageId,
        createdAt: message.createdAt,
        ...(author ? { author } : undefined),
        text: message.text,
        ...(attachments ? { attachments } : undefined),
        delivery: message.delivery,
      },
    ];
  });
  const authorization = report?.authorization;
  return {
    pendingMessages,
    ...(authorization
      ? {
          authorization: {
            label: authorization.label,
            url: authorization.authorizationUrl,
          },
        }
      : undefined),
  };
}

/**
 * Read pending work for a send result. The message already landed, so a
 * failed read drops these optional fields instead of turning the accepted
 * send into a tool error that a client may retry.
 */
export async function readMcpPendingWorkAfterSend(
  user: User,
  conversationId: string,
): Promise<Partial<McpPendingWork>> {
  try {
    return await readMcpPendingWork(user, conversationId);
  } catch (error) {
    logException(error, "mcp.pending_work.read.failed", {
      "gen_ai.conversation.id": conversationId,
    });
    return {};
  }
}

/** `cursor` result field shared by getConversation and the send tools. */
export const mcpCursorSchema = z
  .string()
  .describe(
    "Pass as `after` to getConversation to read the messages that come after this point.",
  );

/** Result of a tool that sends a message. */
export const mcpAcceptedMessageSchema = {
  conversationId: z.string(),
  messageId: z
    .string()
    .describe(
      "Id of your message in `pendingMessages`, and later in the transcript.",
    ),
  status: z
    .enum(["accepted", "duplicate"])
    .describe("`duplicate` when the idempotency key was already used."),
  pendingMessages: mcpPendingMessagesSchema
    .optional()
    .describe(
      "Accepted messages that no turn has read yet, oldest first. Missing when the read failed after your message was accepted; use getConversation.",
    ),
  authorization: mcpAuthorizationSchema.optional(),
  cursor: mcpCursorSchema,
  url: z.string().optional().describe("Dashboard link."),
};
