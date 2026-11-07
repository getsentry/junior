/**
 * MCP view of one Conversation summary. It imports no runtime state, so the
 * token-only CLI prints the same shape.
 */
import * as z from "zod";
import {
  conversationKindSchema,
  conversationReportStatusSchema,
  conversationSurfaceSchema,
  type ConversationSummaryReport,
} from "@/api/schema/conversation";

/** MCP view of one Conversation. It omits dashboard-only fields. */
export const mcpConversationSchema = z
  .object({
    conversationId: z.string(),
    title: z.string(),
    kind: conversationKindSchema.describe(
      "`root` for a top-level Conversation. `thread` and `task` run under `parentConversationId`.",
    ),
    parentConversationId: z.string().optional(),
    status: conversationReportStatusSchema.describe(
      "`active` while work runs, waits to start, or waits on you. `completed` when no work is left. `failed` when the last turn failed. `stopped` after a person or a parent agent stopped it, until a person sends it input or its parent gives it new work.",
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
    kind: summary.kind,
    parentConversationId: summary.parentConversationId,
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
    url: summary.dashboardUrl,
  };
}
