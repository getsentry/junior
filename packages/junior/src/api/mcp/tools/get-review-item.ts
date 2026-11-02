import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readReviewItemForUser,
  ReviewItemActionError,
} from "@/chat/review-items/actions";
import { mcpReviewItem, mcpReviewItemSchema } from "../review-item";
import {
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `getReviewItem`, which reads one Review item in any status. */
export function registerGetReviewItemTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "getReviewItem",
    {
      title: "Get review item",
      description: "Get one review item, open or closed.",
      inputSchema: {
        id: z.string().min(1).describe("Review item id from listReviewItems."),
      },
      outputSchema: { item: mcpReviewItemSchema },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ id }) => {
      try {
        const item = await readReviewItemForUser(user, id);
        return mcpToolResult({ item: mcpReviewItem(item, user.id) });
      } catch (error) {
        if (error instanceof ReviewItemActionError) {
          return mcpToolError(error.message);
        }
        throw error;
      }
    },
  );
}
