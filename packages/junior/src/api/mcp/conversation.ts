/** Own the MCP view of one Conversation, shared by the conversation tools. */
import { z } from "zod";
import {
  conversationReportStatusSchema,
  conversationSurfaceSchema,
  type ConversationReportEvent,
  type ConversationSummaryReport,
} from "@/api/schema/conversation";
import { getDashboardConversationLink } from "@/chat/dashboard-link";

/** MCP view of one Conversation. It omits dashboard-only fields. */
export const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    status: conversationReportStatusSchema,
    surface: conversationSurfaceSchema,
    channelName: z.string().optional(),
    locationUrl: z.string().optional(),
    startedAt: z.string(),
    lastSeenAt: z.string(),
    archivedAt: z.string().optional(),
    url: z.string().optional(),
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
    archivedAt: summary.archivedAt ?? undefined,
    url: getDashboardConversationLink(summary.conversationId),
  };
}

/** Conversation id param shared by the conversation tools. */
export const mcpConversationIdSchema = z
  .string()
  .min(1)
  .describe("Conversation id from searchConversations.");

/** MCP view of one user or assistant Message. */
export const mcpMessageSchema = z
  .object({
    seq: z.number().int(),
    createdAt: z.string(),
    role: z.enum(["assistant", "user"]),
    author: z.string().optional(),
    text: z.string(),
    attachments: z
      .array(
        z
          .object({
            filename: z.string(),
            contentType: z.string(),
            bytes: z.number().int(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

type McpMessage = z.output<typeof mcpMessageSchema>;

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
    const attachments = data.attachments?.map(
      ({ bytes, contentType, filename }) => ({ bytes, contentType, filename }),
    );
    if (!text && !attachments?.length) return [];
    const author =
      data.actorIdentity?.fullName ?? data.actorIdentity?.slackUserName;
    return [
      {
        seq: event.seq,
        createdAt: event.createdAt,
        role: data.role,
        ...(author ? { author } : undefined),
        text,
        ...(attachments?.length ? { attachments } : undefined),
      },
    ];
  });
}
