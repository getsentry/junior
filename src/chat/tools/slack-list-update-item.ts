import { tool } from "ai";
import { z } from "zod";
import { updateListItem } from "@/chat/slack-actions/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListUpdateItemTool(state: ToolState) {
  return tool({
    description: "Update an existing Slack list item (completion state or title).",
    inputSchema: z
      .object({
        list_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional list ID. Defaults to the last list used in this thread."),
        item_id: z
          .string()
          .min(1)
          .describe("ID of the Slack list item to update."),
        completed: z
          .boolean()
          .optional()
          .describe("Optional completion status update."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Optional new item title.")
      })
      .refine((value) => value.completed !== undefined || value.title !== undefined, {
        message: "Provide at least one field to update: completed or title"
      }),
    execute: async ({ list_id, item_id, completed, title }) => {
      try {
        const targetListId = list_id ?? state.getCurrentListId();
        if (!targetListId) {
          return { ok: false, error: "No list_id provided and no prior list found in thread state" };
        }
        const operationKey = createOperationKey("slack_list_update_item", {
          list_id: targetListId,
          item_id,
          completed: completed ?? null,
          title: title ?? null
        });
        const cached = state.getOperationResult<{
          ok: true;
          list_id: string;
          item_id: string;
          completed?: boolean;
          title?: string;
        }>(operationKey);
        if (cached) {
          return {
            ...cached,
            deduplicated: true
          };
        }

        await updateListItem({
          listId: targetListId,
          itemId: item_id,
          completed,
          title,
          listColumnMap: state.artifactState.listColumnMap ?? {}
        });

        state.patchArtifactState({ lastListId: targetListId });

        const response = {
          ok: true,
          list_id: targetListId,
          item_id,
          completed,
          title
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "list item update failed");
      }
    }
  });
}
