import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { markConversationRead } from "@/api/conversations/read-position";
import { mcpConversationIdSchema } from "../conversation";
import {
  apiToolError,
  isConversationParticipant,
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `markConversationRead`, which moves the user's read position. */
export function registerMarkConversationReadTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "markConversationRead",
    {
      title: "Mark conversation read",
      description:
        "Mark one of your conversations as read for you. The read position only moves forward.",
      inputSchema: {
        conversationId: mcpConversationIdSchema,
        lastReadSeq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "`seq` of the last message read, from listConversationMessages. Omit it to mark every message read.",
          ),
      },
      outputSchema: { lastReadSeq: z.number().int() },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ conversationId, lastReadSeq }) => {
      if (!(await isConversationParticipant(user, conversationId))) {
        return mcpToolError("Conversation not found.");
      }
      try {
        return mcpToolResult(
          await markConversationRead(user, conversationId, {
            // The store cuts a value past the last event to the last event.
            lastReadSeq: lastReadSeq ?? Number.MAX_SAFE_INTEGER,
          }),
        );
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}
