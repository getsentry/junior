import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { updateListItem } from "@/chat/slack-actions/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListUpdateItemTool(state: ToolState) {
  return tool({
    description:
      "Update an existing Slack list item (title/completion). Use when the user asks to mark progress or rename a tracked task. Do not use to add new tasks.",
    inputSchema: Type.Object(
      {
        list_id: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional list ID. Defaults to the last list used in this thread."
          })
        ),
        item_id: Type.String({
          minLength: 1,
          description: "ID of the Slack list item to update."
        }),
        completed: Type.Optional(
          Type.Boolean({
            description: "Optional completion status update."
          })
        ),
        title: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional new item title."
          })
        )
      },
      {
        anyOf: [{ required: ["completed"] }, { required: ["title"] }]
      }
    ),
    execute: async ({ list_id, item_id, completed, title }) => {
      const targetListId = list_id ?? state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No list_id provided and no prior list found in thread state" };
      }
      const operationKey = createOperationKey("slackListUpdateItem", {
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
    }
  });
}
