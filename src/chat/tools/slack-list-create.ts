import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { createTodoList } from "@/chat/slack-actions/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListCreateTool(state: ToolState) {
  return tool({
    description: "Create a Slack todo list for action tracking.",
    inputSchema: Type.Object({
      name: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "Name for the new Slack list."
      })
    }),
    execute: async ({ name }) => {
      const operationKey = createOperationKey("slack_list_create", { name });
      const cached = state.getOperationResult<{
        ok: true;
        list_id: string;
        permalink: string;
        column_map: unknown;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }

      const list = await createTodoList(name);
      state.patchArtifactState({
        lastListId: list.listId,
        lastListUrl: list.permalink,
        listColumnMap: list.listColumnMap
      });

      const response = {
        ok: true,
        list_id: list.listId,
        permalink: list.permalink,
        column_map: list.listColumnMap
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}
