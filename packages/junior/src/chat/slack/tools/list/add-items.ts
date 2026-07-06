import { addListItems } from "@/chat/slack/tools/list/api";
import {
  parseRequiredSlackUserIdParam,
  slackUserIdParam,
} from "@/chat/slack/id-param";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that appends items to the active Slack list. */
export function createSlackListAddItemsTool(state: ToolState) {
  return zodTool({
    description:
      "Add tasks to the active Slack list tracked in artifact context. Use when the user wants actionable items recorded in the current thread list. Do not use when no list exists and list creation was not requested.",
    inputSchema: z.object({
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
    execute: async ({ items, assignee_user_id, due_date }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const parsedAssigneeUserId =
        assignee_user_id === undefined
          ? undefined
          : parseRequiredSlackUserIdParam("assignee_user_id", assignee_user_id);
      if (parsedAssigneeUserId?.ok === false) {
        throw new ToolInputError(parsedAssigneeUserId.error);
      }

      const operationKey = createOperationKey("slackListAddItems", {
        list_id: targetListId,
        items,
        assignee_user_id: parsedAssigneeUserId?.value ?? null,
        due_date: due_date ?? null,
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
          deduplicated: true,
        };
      }

      const result = await addListItems({
        listId: targetListId,
        titles: items,
        listColumnMap: state.artifactState.listColumnMap,
        assigneeUserId: parsedAssigneeUserId?.value,
        dueDate: due_date,
      });

      await state.patchArtifactState({
        lastListId: targetListId,
        listColumnMap: result.listColumnMap,
      });

      const response = {
        ok: true,
        list_id: targetListId,
        created_item_ids: result.createdItemIds,
        created_count: result.createdItemIds.length,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
