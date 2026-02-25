import { tool } from "ai";
import { z } from "zod";
import { addListItems } from "@/chat/slack-actions/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListAddItemsTool(state: ToolState) {
  return tool({
    description: "Add one or more todo items to a Slack list.",
    inputSchema: z.object({
      list_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional list ID. Defaults to the last list used in this thread."),
      items: z
        .array(z.string().min(1))
        .min(1)
        .max(25)
        .describe("List item titles to create."),
      assignee_user_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional Slack user ID assigned to all created items."),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Optional due date in YYYY-MM-DD format.")
    }),
    execute: async ({ list_id, items, assignee_user_id, due_date }) => {
      try {
        const targetListId = list_id ?? state.getCurrentListId();
        if (!targetListId) {
          return { ok: false, error: "No list_id provided and no prior list found in thread state" };
        }
        const operationKey = createOperationKey("slack_list_add_items", {
          list_id: targetListId,
          items,
          assignee_user_id: assignee_user_id ?? null,
          due_date: due_date ?? null
        });
        const cached = state.getOperationResult<{
          ok: true;
          list_id: string;
          created_item_ids: string[];
          created_count: number;
        }>(operationKey);
        if (cached) {
          return {
            ...cached,
            deduplicated: true
          };
        }

        const result = await addListItems({
          listId: targetListId,
          titles: items,
          listColumnMap: state.artifactState.listColumnMap,
          assigneeUserId: assignee_user_id,
          dueDate: due_date
        });

        state.patchArtifactState({
          lastListId: targetListId,
          listColumnMap: result.listColumnMap
        });

        const response = {
          ok: true,
          list_id: targetListId,
          created_item_ids: result.createdItemIds,
          created_count: result.createdItemIds.length
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "list item create failed");
      }
    }
  });
}
