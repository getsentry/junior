import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readConversationDetail } from "@/api/conversations/detail";
import {
  conversationBriefSchema,
  type ConversationBrief,
} from "@/chat/briefs/schema";
import {
  mcpConversation,
  mcpConversationIdSchema,
  mcpConversationSchema,
  mcpAuthorizationSchema,
  mcpMessages,
  mcpMessageSchema,
  mcpPendingMessagesSchema,
  readMcpPendingWork,
} from "../conversation";
import {
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

// The Brief without its activity counts and search keywords.
const mcpBriefSchema = conversationBriefSchema
  .omit({ keywords: true, record: true, schemaVersion: true })
  .extend({ updatedAt: z.string() });

function mcpBrief(
  brief: ConversationBrief,
  updatedAt: string,
): z.output<typeof mcpBriefSchema> {
  return {
    summary: brief.summary,
    intent: brief.intent,
    outcome: brief.outcome,
    decisions: brief.decisions,
    openDecisions: brief.openDecisions,
    facts: brief.facts,
    links: brief.links,
    updatedAt,
  };
}

// The newest report events to search for the last Reply. A long tool run
// can push the Reply out of this window. Then `listConversationMessages`
// still finds it.
const RECENT_EVENT_LIMIT = 100;

/**
 * Register `getConversation`. It returns metadata, the Brief, and the last
 * Reply, not the whole transcript.
 */
export function registerGetConversationTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "getConversation",
    {
      title: "Get conversation",
      description:
        "Get one conversation: its metadata, its Brief (a summary of intent, outcome, and state), the last assistant reply, and the messages that no turn has read yet. Use listConversationMessages for the full transcript.",
      inputSchema: { conversationId: mcpConversationIdSchema },
      outputSchema: {
        conversation: mcpConversationSchema,
        brief: mcpBriefSchema.optional(),
        lastReply: mcpMessageSchema
          .optional()
          .describe("Newest assistant message in the recent events."),
        pendingMessages: mcpPendingMessagesSchema,
        authorization: mcpAuthorizationSchema.optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ conversationId }) => {
      const detail = (await isConversationParticipant(user, conversationId))
        ? await readConversationDetail(conversationId, {
            limit: RECENT_EVENT_LIMIT,
            viewer: user,
          })
        : undefined;
      if (!detail) return mcpToolError("Conversation not found.");
      const lastReply = mcpMessages(detail.events)
        .filter((message) => message.role === "assistant")
        .at(-1);
      return mcpToolResult({
        conversation: mcpConversation(detail),
        ...(detail.brief
          ? {
              brief: mcpBrief(detail.brief.content, detail.brief.updatedAt),
            }
          : undefined),
        ...(lastReply ? { lastReply } : undefined),
        ...(await readMcpPendingWork(user, conversationId)),
      });
    },
  );
}
