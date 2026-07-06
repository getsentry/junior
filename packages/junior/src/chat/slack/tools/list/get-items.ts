import { listItems } from "@/chat/slack/tools/list/api";
import { z } from "zod";
import { zodTool } from "@/chat/tools/definition";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that reads items from the active Slack list. */
export function createSlackListGetItemsTool(state: ToolState) {
  return zodTool({
    description:
      "Read items from the active Slack list tracked in artifact context. Use when the user asks for task status, open items, or list contents. Do not use when list state is already known from the immediately prior result.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .describe("Maximum number of list items to return.")
        .optional(),
    }),
    execute: async ({ limit }) => {
      const targetListId = state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }

      const items = await listItems(targetListId, resolvedLimit);

      return {
        ok: true,
        list_id: targetListId,
        items: items.map((item) => ({ id: item.id, fields: item.fields })),
      };
    },
  });
}
