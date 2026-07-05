import { createTodoList } from "@/chat/slack/tools/list/api";
import { tool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";
import { Type } from "@sinclair/typebox";

/** Create a tool that provisions a new Slack todo list. */
export function createSlackListCreateTool(state: ToolState) {
  return tool({
    description:
      "Create a Slack todo list for action tracking. Use when the user needs structured tasks with ownership/completion tracking. Do not use for one-off notes without task management needs.",
    inputSchema: Type.Object({
      name: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "Name for the new Slack list.",
      }),
    }),
    execute: async ({ name }) => {
      const operationKey = createOperationKey("slackListCreate", { name });
      const cached = state.getOperationResult<{
        ok: true;
        list_id: string;
        permalink: string;
        column_map: unknown;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const list = await createTodoList(name);
      await state.patchArtifactState({
        lastListId: list.listId,
        lastListUrl: list.permalink,
        listColumnMap: list.listColumnMap,
      });

      const response = {
        ok: true,
        list_id: list.listId,
        permalink: list.permalink,
        column_map: list.listColumnMap,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
