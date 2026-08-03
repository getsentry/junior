import { listItems } from "@/chat/slack/tools/list/api";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolState } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Create a tool that reads items from the active Slack list. */
export function createSlackListGetItemsTool(state: ToolState) {
  return zodTool({
    description:
      "Read items from the active Slack list tracked in artifact context. Use when the user asks for task status, open items, or list contents. Do not use when list state is already known from the immediately prior result.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .describe("Maximum number of list items to return.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ limit }) => {
      const targetListId = state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        throw new ToolInputError("No active list found in artifact context");
      }

      const items = await listItems(targetListId, resolvedLimit);

      return {
        list_id: targetListId,
        items: items.map((item) => ({ id: item.id, fields: item.fields })),
      };
    },
  });
}
