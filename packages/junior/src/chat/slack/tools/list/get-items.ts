import { listItems } from "@/chat/slack/tools/list/api";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that reads items from an explicit Slack list. */
export function createSlackListGetItemsTool(state: ToolState) {
  return zodTool({
    description:
      "Read items from a Slack list. Use the list_id from a prior tool result or conversation history.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      list_id: z.string().min(1).describe("ID of the Slack list to read."),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .describe("Maximum number of list items to return.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ list_id, limit }) => {
      const resolvedLimit = limit ?? 100;
      const items = await listItems(list_id, resolvedLimit);

      return {
        list_id,
        items: items.map((item) => ({ id: item.id, fields: item.fields })),
      };
    },
  });
}
