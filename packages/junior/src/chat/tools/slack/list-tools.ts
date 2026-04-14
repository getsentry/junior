import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import {
  addListItems,
  createTodoList,
  listItems,
  updateListItem,
} from "@/chat/tools/slack/lists";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

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

/** Create a tool that appends items to the active Slack list. */
export function createSlackListAddItemsTool(state: ToolState) {
  return tool({
    description:
      "Add tasks to the active Slack list tracked in artifact context. Use when the user wants actionable items recorded in the current thread list. Do not use when no list exists and list creation was not requested.",
    inputSchema: Type.Object({
      items: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 25,
        description: "List item titles to create.",
      }),
      assignee_user_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional Slack user ID assigned to all created items.",
        }),
      ),
      due_date: Type.Optional(
        Type.String({
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Optional due date in YYYY-MM-DD format.",
        }),
      ),
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
        assigneeUserId: assignee_user_id,
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

/** Create a tool that reads items from the active Slack list. */
export function createSlackListGetItemsTool(state: ToolState) {
  return tool({
    description:
      "Read items from the active Slack list tracked in artifact context. Use when the user asks for task status, open items, or list contents. Do not use when list state is already known from the immediately prior result.",
    inputSchema: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of list items to return.",
        }),
      ),
    }),
    execute: async ({ limit }) => {
      const targetListId = state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }

      const items = await listItems(targetListId, resolvedLimit);

      return {
        ok: true,
        list_id: targetListId,
        items: items.map((item) => ({ id: item.id, fields: item.fields })),
      };
    },
  });
}

/** Create a tool that updates an item in the active Slack list. */
export function createSlackListUpdateItemTool(state: ToolState) {
  return tool({
    description:
      "Update an item in the active Slack list tracked in artifact context (title/completion). Use when the user asks to mark progress or rename a tracked task. Do not use to add new tasks.",
    inputSchema: Type.Object(
      {
        item_id: Type.String({
          minLength: 1,
          description: "ID of the Slack list item to update.",
        }),
        completed: Type.Optional(
          Type.Boolean({
            description: "Optional completion status update.",
          }),
        ),
        title: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional new item title.",
          }),
        ),
      },
      {
        anyOf: [{ required: ["completed"] }, { required: ["title"] }],
      },
    ),
    execute: async ({ item_id, completed, title }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const operationKey = createOperationKey("slackListUpdateItem", {
        list_id: targetListId,
        item_id,
        completed: completed ?? null,
        title: title ?? null,
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
          deduplicated: true,
        };
      }

      await updateListItem({
        listId: targetListId,
        itemId: item_id,
        completed,
        title,
        listColumnMap: state.artifactState.listColumnMap ?? {},
      });

      await state.patchArtifactState({ lastListId: targetListId });

      const response = {
        ok: true,
        list_id: targetListId,
        item_id,
        completed,
        title,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
