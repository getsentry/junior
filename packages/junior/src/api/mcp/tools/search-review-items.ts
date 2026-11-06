import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getDb } from "@/chat/db";
import { reviewItemReaderForUser } from "@/chat/review-items/access";
import { searchReviewItems } from "@/chat/review-items/store";
import { mcpReviewItem, mcpReviewItemSchema } from "../review-item";
import { mcpToolResult, type McpToolContext } from "../tool-context";

/** Register `searchReviewItems`, which searches open Review items for the user. */
export function registerSearchReviewItemsTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "searchReviewItems",
    {
      title: "Search review items",
      description:
        "Search the open review items that you can see, newest change first. A review item is a question or notice that waits for a person.",
      inputSchema: {
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Words to find in the title or body."),
        conversationId: z
          .string()
          .min(1)
          .optional()
          .describe("Return only the items linked to this conversation."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of items."),
      },
      outputSchema: {
        items: z.array(mcpReviewItemSchema),
        truncated: z.boolean().describe("True when more items match."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ conversationId, limit, q }) => {
      // Read one more item than the limit to learn whether more match.
      const items = await searchReviewItems(
        getDb(),
        reviewItemReaderForUser(user),
        {
          ...(conversationId ? { conversationId } : undefined),
          limit: limit + 1,
          ...(q ? { query: q } : undefined),
          statuses: ["open"],
        },
      );
      return mcpToolResult({
        items: items
          .slice(0, limit)
          .map((item) => mcpReviewItem(item, user.id)),
        truncated: items.length > limit,
      });
    },
  );
}
