import type { SlackListsItemsListResponse } from "@slack/web-api";
import type { RichTextBlock } from "@slack/types";
import { getFilePermalink, getSlackClient, withSlackRetries } from "@/chat/slack-actions/client";
import type { ListColumnMap } from "@/chat/slack-actions/types";

interface SlackListsSchemaColumnResponse {
  id: string;
  key: string;
  name: string;
  type: string;
  is_primary_column?: boolean;
}

type SlackListsItemField =
  | { column_id: string; rich_text: RichTextBlock[] }
  | { column_id: string; user: string[] }
  | { column_id: string; date: string[] }
  | { column_id: string; checkbox: boolean };

interface SlackListsItem {
  id: string;
  fields: unknown[];
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

export function inferListColumnMap(schema: SlackListsSchemaColumnResponse[] = []): ListColumnMap {
  const pick = (predicate: (column: SlackListsSchemaColumnResponse) => boolean): string | undefined =>
    schema.find(predicate)?.id;

  return {
    titleColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.is_primary_column || key.includes("title") || key.includes("task") || key.includes("name");
    }),
    completedColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "checkbox" || key.includes("done") || key.includes("complete") || key.includes("status");
    }),
    assigneeColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "user" || key.includes("owner") || key.includes("assignee");
    }),
    dueDateColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "date" || key.includes("due") || key.includes("deadline");
    })
  };
}

function richTextField(columnId: string, value: string): SlackListsItemField {
  return {
    column_id: columnId,
    rich_text: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: value }]
          }
        ]
      }
    ] as RichTextBlock[]
  } as SlackListsItemField;
}

const DEFAULT_TODO_SCHEMA = [
  { key: "task", name: "Task", type: "rich_text", is_primary_column: true },
  { key: "completed", name: "Completed", type: "checkbox" },
  { key: "assignee", name: "Assignee", type: "user" },
  { key: "due_date", name: "Due Date", type: "date" }
];

export async function createTodoList(
  name: string
): Promise<{ listId: string; listColumnMap: ListColumnMap; permalink?: string }> {
  const client = getSlackClient();
  const result = await withSlackRetries(() =>
    client.slackLists.create({
      name,
      schema: DEFAULT_TODO_SCHEMA,
      todo_mode: true
    })
  );

  if (!result.list_id) {
    throw new Error("Slack list was created without list_id");
  }

  const listColumnMap = inferListColumnMap(result.list_metadata?.schema ?? []);

  let permalink: string | undefined;
  try {
    permalink = await getFilePermalink(result.list_id);
  } catch {
    // List creation succeeded; permalink lookup is best-effort.
  }

  return {
    listId: result.list_id,
    listColumnMap,
    permalink
  };
}

export async function addListItems(input: {
  listId: string;
  titles: string[];
  listColumnMap?: ListColumnMap;
  assigneeUserId?: string;
  dueDate?: string;
}): Promise<{ createdItemIds: string[]; listColumnMap?: ListColumnMap }> {
  const client = getSlackClient();

  const listColumnMap = input.listColumnMap ?? {};
  if (!listColumnMap.titleColumnId) {
    throw new Error("Cannot add list items because title column could not be inferred");
  }

  const createdItemIds: string[] = [];

  for (const title of input.titles) {
    const initialFields: SlackListsItemField[] = [richTextField(listColumnMap.titleColumnId, title)];

    if (input.assigneeUserId && listColumnMap.assigneeColumnId) {
      initialFields.push({
        column_id: listColumnMap.assigneeColumnId,
        user: [input.assigneeUserId]
      });
    }

    if (input.dueDate && listColumnMap.dueDateColumnId) {
      initialFields.push({
        column_id: listColumnMap.dueDateColumnId,
        date: [input.dueDate]
      });
    }

    const response = await withSlackRetries(() =>
      client.slackLists.items.create({
        list_id: input.listId,
        initial_fields: initialFields as never
      })
    );

    if (response.item?.id) {
      createdItemIds.push(response.item.id);
    }
  }

  return {
    createdItemIds,
    listColumnMap
  };
}

export async function listItems(listId: string, limit = 100): Promise<SlackListsItem[]> {
  const client = getSlackClient();
  const items: SlackListsItem[] = [];
  let cursor: string | undefined;
  const cappedLimit = Math.max(1, Math.min(limit, 200));

  do {
    const response: SlackListsItemsListResponse = await withSlackRetries(() =>
      client.slackLists.items.list({
        list_id: listId,
        limit: cappedLimit,
        cursor
      })
    );

    const remaining = cappedLimit - items.length;
    if (remaining <= 0) {
      break;
    }
    items.push(...(response.items ?? []).slice(0, remaining));
    if (items.length >= cappedLimit) {
      break;
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return items;
}

export async function updateListItem(input: {
  listId: string;
  itemId: string;
  listColumnMap: ListColumnMap;
  completed?: boolean;
  title?: string;
}): Promise<void> {
  const client = getSlackClient();
  const cells: Array<{ row_id: string } & SlackListsItemField> = [];

  if (typeof input.completed === "boolean" && input.listColumnMap.completedColumnId) {
    cells.push({
      row_id: input.itemId,
      column_id: input.listColumnMap.completedColumnId,
      checkbox: input.completed
    } as { row_id: string } & SlackListsItemField);
  }

  if (typeof input.title === "string" && input.title.trim() && input.listColumnMap.titleColumnId) {
    cells.push({
      row_id: input.itemId,
      ...(richTextField(input.listColumnMap.titleColumnId, input.title) as SlackListsItemField)
    } as { row_id: string } & SlackListsItemField);
  }

  if (cells.length === 0) {
    throw new Error("No updatable fields were provided or inferred for this list item");
  }

  await withSlackRetries(() =>
    client.slackLists.items.update({
      list_id: input.listId,
      cells: cells as never
    })
  );
}
