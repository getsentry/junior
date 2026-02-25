import { tool } from "ai";
import { z } from "zod";
import { addListItems } from "@/chat/slack-actions/lists";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListAddItemsTool(state: ToolState) {
  return tool({
    description: "Add one or more todo items to a Slack list.",
    inputSchema: z.object({
      list_id: z.string().min(1).optional(),
      items: z.array(z.string().min(1)).min(1).max(25),
      assignee_user_id: z.string().min(1).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    }),
    execute: async ({ list_id, items, assignee_user_id, due_date }) => {
      try {
        const targetListId = list_id ?? state.getCurrentListId();
        if (!targetListId) {
          return { ok: false, error: "No list_id provided and no prior list found in thread state" };
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

        return {
          ok: true,
          list_id: targetListId,
          created_item_ids: result.createdItemIds,
          created_count: result.createdItemIds.length
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "list item create failed"
        };
      }
    }
  });
}
