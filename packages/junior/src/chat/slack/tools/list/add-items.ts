import { addListItems } from "@/chat/slack/tools/list/api";
import {
  parseRequiredSlackUserIdParam,
  slackUserIdParam,
} from "@/chat/slack/id-param";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that appends items to an explicit Slack list. */
export function createSlackListAddItemsTool(state: ToolState) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Add tasks to a Slack list. Use the list_id from the list create result or conversation history.",
    inputSchema: z.object({
      list_id: z.string().min(1).describe("ID of the Slack list to update."),
      items: z
        .array(z.string().min(1))
        .min(1)
        .max(25)
        .describe("List item titles to create."),
      assignee_user_id: slackUserIdParam(
        "Optional Slack user ID assigned to all created items.",
      ).optional(),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Optional due date in YYYY-MM-DD format.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ list_id, items, assignee_user_id, due_date }) => {
      const parsedAssigneeUserId =
        assignee_user_id === undefined
          ? undefined
          : parseRequiredSlackUserIdParam("assignee_user_id", assignee_user_id);
      if (parsedAssigneeUserId?.ok === false) {
        throw new ToolInputError(parsedAssigneeUserId.error);
      }

      const operationKey = createOperationKey("slackListAddItems", {
        list_id: list_id,
        items,
        assignee_user_id: parsedAssigneeUserId?.value ?? null,
        due_date: due_date ?? null,
      });
      const cached = state.getOperationResult<{
        list_id: string;
        created_item_ids: string[];
        created_count: number;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const result = await addListItems({
        listId: list_id,
        titles: items,
        assigneeUserId: parsedAssigneeUserId?.value,
        dueDate: due_date,
      });

      const response = {
        list_id: list_id,
        created_item_ids: result.createdItemIds,
        created_count: result.createdItemIds.length,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
