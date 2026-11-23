import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from "@/api/conversations/cursor";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationEventPageAfter } from "@/api/conversations/event-page";
import { getSqlExecutor } from "@/chat/db";
import {
  mcpActivity,
  mcpActivitySchema,
  mcpConversation,
  mcpConversationIdSchema,
  mcpCursorSchema,
  mcpConversationSchema,
  mcpIncludeActivitySchema,
  mcpAuthorizationSchema,
  mcpMessages,
  mcpMessageSchema,
  type McpActivity,
  type McpMessage,
  mcpPendingMessagesSchema,
  readMcpPendingWork,
} from "../conversation";
import {
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

// The newest report events to search for the last Reply. A long tool run
// can push the Reply out of this window. Then `listConversationMessages`
// still finds it.
const RECENT_EVENT_LIMIT = 100;

// Report events read after `after`. Tool calls share this budget.
const AFTER_EVENT_SCAN_LIMIT = 200;
// Messages returned after `after`. Long replies can be large.
const AFTER_MESSAGE_LIMIT = 20;

/**
 * Read the Messages after a transcript position, the activity up to the last
 * of them when `includeActivity` is set, and the position to continue from.
 * The cursor stops at the last returned Message when more are left.
 */
async function readMessagesAfter(
  conversationId: string,
  afterSeq: number,
  includeActivity: boolean,
): Promise<{
  activity?: McpActivity[];
  messages: McpMessage[];
  hasMore: boolean;
  seq: number;
}> {
  // Participants can see private content.
  const page = await readConversationEventPageAfter(getSqlExecutor(), {
    afterSeq,
    canExposePayload: true,
    conversationId,
    limit: AFTER_EVENT_SCAN_LIMIT,
  });
  const scanned = mcpMessages(page.events);
  const messages = scanned.slice(0, AFTER_MESSAGE_LIMIT);
  const cut = scanned.length > messages.length;
  const seq = cut
    ? messages.at(-1)!.seq
    : (page.events.at(-1)?.seq ?? afterSeq);
  return {
    ...(includeActivity
      ? { activity: mcpActivity(page.events.filter((e) => e.seq <= seq)) }
      : undefined),
    messages,
    hasMore: cut || page.nextSeq !== undefined,
    seq,
  };
}

/**
 * Register `getConversation`. It returns metadata, the summary, and the last
 * Reply or the Messages after a cursor, not the whole transcript.
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
        "Get one conversation: its metadata, including its summary, the messages that no turn has read yet, and a `cursor`. Without `after`, it returns the last assistant reply. With `after`, it returns the messages after that point instead. To follow a conversation, call it again with the newest `cursor` until `turnActive` is false and `hasMore` is not set. Use listConversationMessages for older messages.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        after: z
          .string()
          .min(1)
          .max(1_000)
          .optional()
          .describe(
            "`cursor` from sendMessage, createConversation, or an earlier getConversation call.",
          ),
        includeActivity: mcpIncludeActivitySchema,
      },
      outputSchema: {
        conversation: mcpConversationSchema,
        lastReply: mcpMessageSchema
          .optional()
          .describe(
            "Newest assistant message in the recent events. Set only without `after`.",
          ),
        messages: z
          .array(mcpMessageSchema)
          .optional()
          .describe(
            "User and assistant messages after `after`, oldest first. Set only with `after`.",
          ),
        activity: z
          .array(mcpActivitySchema)
          .optional()
          .describe(
            "Set only with `after` and `includeActivity`. Oldest first.",
          ),
        hasMore: z
          .boolean()
          .optional()
          .describe(
            "True when more messages already follow `cursor`. Call again now, also when `turnActive` is false.",
          ),
        pendingMessages: mcpPendingMessagesSchema,
        authorization: mcpAuthorizationSchema.optional(),
        cursor: mcpCursorSchema,
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ after, conversationId, includeActivity }) => {
      const afterSeq = after
        ? decodeConversationCursor({ conversationId, cursor: after })?.seq
        : undefined;
      if (after && afterSeq === undefined) {
        return mcpToolError(
          "The cursor is not valid. Omit `after` to read the current state.",
        );
      }
      const detail = (await isConversationParticipant(user, conversationId))
        ? await readConversationDetail(conversationId, {
            limit: RECENT_EVENT_LIMIT,
            viewer: user,
          })
        : undefined;
      if (!detail) return mcpToolError("Conversation not found.");
      // Read the Messages after the status. A client that sees a finished
      // status then also gets every Message that the Turn wrote.
      const newer =
        afterSeq === undefined
          ? undefined
          : detail.eventHistory.status === "expired"
            ? { messages: [], hasMore: false, seq: afterSeq }
            : await readMessagesAfter(
                conversationId,
                afterSeq,
                includeActivity,
              );
      const lastReply = newer
        ? undefined
        : mcpMessages(detail.events)
            .filter((message) => message.role === "assistant")
            .at(-1);
      const cursorSeq = newer?.seq ?? detail.events.at(-1)?.seq ?? -1;
      return mcpToolResult({
        conversation: mcpConversation(detail),
        ...(lastReply ? { lastReply } : undefined),
        ...(newer ? { messages: newer.messages } : undefined),
        ...(newer?.activity ? { activity: newer.activity } : undefined),
        ...(newer?.hasMore ? { hasMore: true } : undefined),
        ...(await readMcpPendingWork(user, conversationId)),
        cursor: encodeConversationCursor({
          conversationId: conversationId,
          seq: cursorSeq,
        }),
      });
    },
  );
}
