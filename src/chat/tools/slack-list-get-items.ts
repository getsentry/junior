import { tool } from "ai";
import { z } from "zod";
import { listItems } from "@/chat/slack-actions/lists";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListGetItemsTool(state: ToolState) {
  return tool({
    description: "List items from a Slack list.",
    inputSchema: z.object({
      list_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional list ID. Defaults to the last list used in this thread."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .describe("Maximum number of list items to return.")
    }),
    execute: async ({ list_id, limit }) => {
      try {
        const targetListId = list_id ?? state.getCurrentListId();
        if (!targetListId) {
          return { ok: false, error: "No list_id provided and no prior list found in thread state" };
        }

        const items = await listItems(targetListId, limit);

        return {
          ok: true,
          list_id: targetListId,
          items: items.map((item) => ({ id: item.id, fields: item.fields }))
        };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "list fetch failed");
      }
    }
  });
}
