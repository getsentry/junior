import { createTodoList } from "@/chat/slack/tool-support/list/api";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that provisions a new Slack todo list. */
export function createSlackListCreateTool(state: ToolState) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Create a Slack todo list for action tracking. Use when the user needs structured tasks with ownership/completion tracking. Do not use for one-off notes without task management needs.",
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe("Name for the new Slack list."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ name }) => {
      const operationKey = createOperationKey("slackListCreate", { name });
      const cached = state.getOperationResult<{
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
      const response = {
        list_id: list.listId,
        permalink: list.permalink,
        column_map: list.listColumnMap,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
