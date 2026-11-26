import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  readInboxItemForUser,
  InboxItemActionError,
} from "@/chat/inbox-items/actions";
import { resolveInboxItemSubjects } from "@/api/inbox-items/resolve-subjects";
import { mcpInboxItem, mcpInboxItemSchema } from "../inbox-item";
import {
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

/** Register `getInboxItem`, which reads one Inbox item in any status. */
export function registerGetInboxItemTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "getInboxItem",
    {
      title: "Get inbox item",
      description: "Get one inbox item, open or closed.",
      inputSchema: {
        id: z.string().min(1).describe("Inbox item id from searchInboxItems."),
      },
      outputSchema: { item: mcpInboxItemSchema },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ id }) => {
      try {
        const item = await readInboxItemForUser(user, id);
        const cards = await resolveInboxItemSubjects(user, [item]);
        return mcpToolResult({ item: mcpInboxItem(item, user.id, cards) });
      } catch (error) {
        if (error instanceof InboxItemActionError) {
          return mcpToolError(error.message);
        }
        throw error;
      }
    },
  );
}
