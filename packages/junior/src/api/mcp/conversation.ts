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
import { getDb } from "@/chat/db";
import { AVATAR_PATH_PREFIX } from "@/chat/identities/avatar";
import { logException } from "@/chat/logging";
import type { User } from "@sentry/junior-plugin-api";
import { readConversationAuthors } from "@/api/conversations/participants";
import { readConversationPendingMessages } from "@/api/conversations/pending-messages";
import { conversationPendingMessageDeliverySchema } from "@/api/schema/conversation-pending-messages";
import { conversationTreeStateSchema } from "@/api/schema/conversation-tree-state";
import { MCP_AVATAR_PATH_PREFIX } from "./oauth/metadata";

/** MCP view of one Conversation. It omits dashboard-only fields. */
export const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    status: conversationReportStatusSchema.describe(
      "`needs_input` while it waits on a person: a Review item it added, a sign-in, a failed latest Turn, a `partial` or `blocked` Brief, or an answer its starter has not read. `working` while a Turn runs or waits to start. `done` otherwise, also after a stop.",
    ),
    turnActive: z
      .boolean()
      .describe(
        "True while a Turn runs or waits to start, whatever `status` is. To follow a Conversation, wait until it is false.",
      ),
    treeState: conversationTreeStateSchema
      .optional()
      .describe(
        "Your viewer state, over this Conversation and all its child agents. `needs_you` when one of them waits on you or on everyone. `working` while a Turn runs or waits to start in any of them. `done` otherwise. Show this in a list, not `status`.",
      ),
    watching: z
      .boolean()
      .optional()
      .describe(
        "True when one of them has an active Watch or a pending Timer. It is not work.",
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
      .describe("Set when anyone archived it. Archive applies to everyone."),
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
    turnActive: summary.turnActive,
    treeState: summary.treeState,
    watching: summary.watching,
    surface: summary.surface,
    channelName: summary.channelNameRedacted ? undefined : summary.channelName,
    locationUrl: summary.locationUrl,
    startedAt: summary.startedAt,
    lastSeenAt: summary.lastSeenAt,
    archivedAt: summary.archivedAt ?? undefined,
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

/** The people who wrote in one Conversation, by Identity id. */
export type McpAuthors = Readonly<Record<string, ActorIdentity>>;

/** Read the people who wrote in one Conversation, by Identity id. */
export async function readMcpAuthors(
  conversationId: string,
): Promise<McpAuthors> {
  return (await readConversationAuthors(getDb(), conversationId)).authors;
}

// The name and photo of the person who wrote one Message. As in the
// dashboard transcript, the participant behind the Identity comes first,
// then the author that the Message stored. The photo path moves to the MCP
// edge, which accepts the MCP bearer token.
function mcpAuthor(
  message: { actorIdentity?: ActorIdentity; actorIdentityId?: string },
  authors: McpAuthors,
): { author?: string; authorAvatarUrl?: string } {
  const identity =
    (message.actorIdentityId && authors[message.actorIdentityId]) ||
    message.actorIdentity;
  const author =
    identity?.fullName ?? identity?.slackUserName ?? identity?.email;
  const photo = identity?.avatarUrl;
  return {
    ...(author ? { author } : undefined),
    ...(photo?.startsWith(AVATAR_PATH_PREFIX)
      ? {
          authorAvatarUrl:
            MCP_AVATAR_PATH_PREFIX + photo.slice(AVATAR_PATH_PREFIX.length),
        }
      : undefined),
  };
}

const mcpAuthorAvatarUrlSchema = z
  .string()
  .optional()
  .describe(
    "Path of the author's profile photo on this server. GET it with the same bearer token.",
  );

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
    authorAvatarUrl: mcpAuthorAvatarUrlSchema,
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
  authors: McpAuthors,
): McpMessage[] {
  return events.flatMap((event) => {
    const data = event.data;
    if (data.type !== "message" || data.role === "system") return [];
    const text = data.text ?? "";
    const attachments = mcpAttachments(data.attachments);
    if (!text && !attachments) return [];
    return [
      {
        seq: event.seq,
        messageId: data.messageId,
        createdAt: event.createdAt,
        role: data.role,
        ...mcpAuthor(data, authors),
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
    authorAvatarUrl: mcpAuthorAvatarUrlSchema,
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
  const messages = report?.messages ?? [];
  const authors = messages.some((message) => message.actorIdentityId)
    ? await readMcpAuthors(conversationId)
    : {};
  const pendingMessages = messages.flatMap((message) => {
    if (message.text === undefined) return [];
    const attachments = mcpAttachments(message.attachments);
    return [
      {
        messageId: message.messageId,
        createdAt: message.createdAt,
        ...mcpAuthor(message, authors),
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
