import { createTodoList } from "@/chat/slack/tool-support/list/api";
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tool-support/idempotency";
import type { ToolState } from "@/chat/tool-support/types";
import { SLACK_TOOL_SOURCE } from "@/chat/slack/tool-support/tool-source";

export const slackListCreateToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: SLACK_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  approvalMode: "review",
  description: "Create a Slack todo list.",
  inputSchema: z.object({
    name: z.string().min(1).max(160).describe("Name for the new Slack list."),
  }),
  outputSchema: juniorToolOutputSchema,
});

/** Create a tool that provisions a new Slack todo list. */
export function createSlackListCreateTool(state: ToolState) {
  return zodTool({
    ...slackListCreateToolDefinition,
    execute: async ({ name }) => {
      const operationKey = createOperationKey("slackListCreate", { name });
      const cached = state.getOperationResult<{
        list_id: string;
        url: string | undefined;
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
        url: list.permalink,
        column_map: list.listColumnMap,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
