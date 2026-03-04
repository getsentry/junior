import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { addListItems } from "@/chat/slack-actions/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListAddItemsTool(state: ToolState) {
  return tool({
    description:
      "Add tasks to the active Slack list tracked in artifact context. Use when the user wants actionable items recorded in the current thread list. Do not use when no list exists and list creation was not requested.",
    inputSchema: Type.Object({
      items: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 25,
        description: "List item titles to create."
      }),
      assignee_user_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional Slack user ID assigned to all created items."
        })
      ),
      due_date: Type.Optional(
        Type.String({
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Optional due date in YYYY-MM-DD format."
        })
      )
    }),
    execute: async ({ items, assignee_user_id, due_date }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const operationKey = createOperationKey("slackListAddItems", {
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
    }
  });
}
