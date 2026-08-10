import { updateListItem } from "@/chat/slack/tool-support/list/api";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

const updateListItemInputSchema = z.union([
  z.object({
    list_id: z.string().min(1).describe("ID of the Slack list to update."),
    item_id: z.string().min(1).describe("ID of the Slack list item to update."),
    completed: booleanInput("Optional completion status update."),
    title: z.string().min(1).describe("Optional new item title.").optional(),
  }),
  z.object({
    list_id: z.string().min(1).describe("ID of the Slack list to update."),
    item_id: z.string().min(1).describe("ID of the Slack list item to update."),
    completed: booleanInput("Optional completion status update.").optional(),
    title: z.string().min(1).describe("Optional new item title."),
  }),
]);

/** Create a tool that updates an item in an explicit Slack list. */
export function createSlackListUpdateItemTool(state: ToolState) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Update an item in a Slack list. Use list_id and item_id from prior tool results or conversation history.",
    inputSchema: updateListItemInputSchema,
    outputSchema: juniorToolOutputSchema,
    execute: async ({ list_id, item_id, completed, title }) => {
      const operationKey = createOperationKey("slackListUpdateItem", {
        list_id: list_id,
        item_id,
        completed: completed ?? null,
        title: title ?? null,
      });
      const cached = state.getOperationResult<{
        list_id: string;
        item_id: string;
        completed?: boolean;
        title?: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      await updateListItem({
        listId: list_id,
        itemId: item_id,
        completed,
        title,
        listColumnMap: {},
      });

      const response = {
        list_id: list_id,
        item_id,
        completed,
        title,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
