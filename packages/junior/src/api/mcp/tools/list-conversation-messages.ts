import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from "@/api/conversations/cursor";
import { readConversationEventPage } from "@/api/conversations/event-page";
import { readConversationRecordFromSql } from "@/api/conversations/record";
import { getSqlExecutor } from "@/chat/db";
import {
  mcpConversationIdSchema,
  mcpMessages,
  mcpMessageSchema,
} from "../conversation";
import {
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

// Report events read for one page. Tool calls and other events share this
// budget, so a page can hold fewer Messages than `limit`.
const EVENT_SCAN_LIMIT = 200;

/** Register `listConversationMessages`, which pages a transcript backward. */
export function registerListConversationMessagesTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "listConversationMessages",
    {
      title: "List conversation messages",
      description:
        "List the user and assistant messages of one conversation, oldest first, ending with the newest. Tool calls are not included.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        before: z
          .string()
          .min(1)
          .max(1_000)
          .optional()
          .describe(
            "`nextCursor` from an earlier call. Lists the messages before it.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of messages."),
      },
      outputSchema: {
        messages: z.array(mcpMessageSchema),
        nextCursor: z
          .string()
          .optional()
          .describe("Set when older messages can exist."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ before, conversationId, limit }) => {
      const record = (await isConversationParticipant(user, conversationId))
        ? await readConversationRecordFromSql(conversationId)
        : undefined;
      if (!record) return mcpToolError("Conversation not found.");
      const beforeSeq = before
        ? decodeConversationCursor({ conversationId, cursor: before })?.seq
        : undefined;
      if (before && beforeSeq === undefined) {
        return mcpToolError(
          "The cursor is not valid. Omit `before` to read the newest messages.",
        );
      }
      if (record.conversation.transcriptPurgedAtMs !== undefined) {
        return mcpToolResult({ messages: [] });
      }
      // Participants can see private content.
      const page = await readConversationEventPage(getSqlExecutor(), {
        beforeSeq,
        canExposePayload: true,
        conversationId,
        limit: EVENT_SCAN_LIMIT,
      });
      const scanned = mcpMessages(page.events);
      const messages = scanned.slice(-limit);
      const olderSeq =
        scanned.length > messages.length ? messages[0]?.seq : page.previousSeq;
      return mcpToolResult({
        messages,
        ...(olderSeq === undefined
          ? undefined
          : {
              nextCursor: encodeConversationCursor({
                conversationId,
                seq: olderSeq,
              }),
            }),
      });
    },
  );
}
