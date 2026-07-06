import { updateListItem } from "@/chat/slack/tools/list/api";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
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
    item_id: z.string().min(1).describe("ID of the Slack list item to update."),
    completed: booleanInput("Optional completion status update."),
    title: z.string().min(1).describe("Optional new item title.").optional(),
  }),
  z.object({
    item_id: z.string().min(1).describe("ID of the Slack list item to update."),
    completed: booleanInput("Optional completion status update.").optional(),
    title: z.string().min(1).describe("Optional new item title."),
  }),
]);

/** Create a tool that updates an item in the active Slack list. */
export function createSlackListUpdateItemTool(state: ToolState) {
  return zodTool({
    description:
      "Update an item in the active Slack list tracked in artifact context (title/completion). Use when the user asks to mark progress or rename a tracked task. Do not use to add new tasks.",
    inputSchema: updateListItemInputSchema,
    outputSchema: juniorToolResultSchema,
    execute: async ({ item_id, completed, title }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return {
          ok: false,
          status: "error" as const,
          error: "No active list found in artifact context",
        };
      }
      const operationKey = createOperationKey("slackListUpdateItem", {
        list_id: targetListId,
        item_id,
        completed: completed ?? null,
        title: title ?? null,
      });
      const cached = state.getOperationResult<{
        ok: true;
        status: "success";
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
        listId: targetListId,
        itemId: item_id,
        completed,
        title,
        listColumnMap: state.artifactState.listColumnMap ?? {},
      });

      await state.patchArtifactState({ lastListId: targetListId });

      const response = {
        ok: true,
        status: "success" as const,
        list_id: targetListId,
        item_id,
        completed,
        title,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
