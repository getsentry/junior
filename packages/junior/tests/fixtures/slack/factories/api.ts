import {
  TEST_CANVAS_ID,
  TEST_CHANNEL_ID,
  TEST_FILE_ID,
  TEST_LIST_ID,
  TEST_MESSAGE_TS,
  TEST_SECTION_ID,
  TEST_THREAD_TS,
  TEST_USER_ID,
  slackTimestamp,
} from "./ids";

type SlackErrorInput = {
  error: string;
  needed?: string;
  provided?: string;
} & Record<string, unknown>;

export function slackOk<T extends Record<string, unknown>>(
  payload?: T,
): { ok: true } & T {
  return {
    ok: true,
    ...(payload ?? ({} as T)),
  };
}

export function slackError(
  input: SlackErrorInput,
): { ok: false } & SlackErrorInput {
  return {
    ok: false,
    ...input,
  };
}

export function chatPostMessageOk(
  input: { ts?: string; channel?: string } = {},
): { ok: true; ts: string; channel: string } {
  return slackOk({
    ts: input.ts ?? TEST_MESSAGE_TS,
    channel: input.channel ?? TEST_CHANNEL_ID,
  });
}

export function chatStartStreamOk(
  input: { ts?: string; channel?: string } = {},
): { ok: true; ts: string; channel: string } {
  return slackOk({
    ts: input.ts ?? TEST_MESSAGE_TS,
    channel: input.channel ?? TEST_CHANNEL_ID,
  });
}

export function chatAppendStreamOk(
  input: { ts?: string; channel?: string } = {},
): { ok: true; ts: string; channel: string } {
  return slackOk({
    ts: input.ts ?? TEST_MESSAGE_TS,
    channel: input.channel ?? TEST_CHANNEL_ID,
  });
}

export function chatStopStreamOk(
  input: { ts?: string; channel?: string } = {},
): { ok: true; ts: string; channel: string } {
  return slackOk({
    ts: input.ts ?? TEST_MESSAGE_TS,
    channel: input.channel ?? TEST_CHANNEL_ID,
  });
}

export function chatPostEphemeralOk(input: { messageTs?: string } = {}): {
  ok: true;
  message_ts: string;
} {
  return slackOk({
    message_ts: input.messageTs ?? TEST_MESSAGE_TS,
  });
}

export function chatGetPermalinkOk(input: { permalink?: string } = {}): {
  ok: true;
  permalink: string;
} {
  return slackOk({
    permalink:
      input.permalink ??
      `https://example.invalid/${TEST_CHANNEL_ID}/${TEST_MESSAGE_TS}`,
  });
}

export function reactionsAddOk(): { ok: true } {
  return slackOk();
}

export function conversationsHistoryPage(
  input: {
    messages?: Array<Record<string, unknown>>;
    nextCursor?: string;
  } = {},
): {
  ok: true;
  messages: Array<Record<string, unknown>>;
  has_more: boolean;
  response_metadata: { next_cursor: string };
} {
  const nextCursor = input.nextCursor ?? "";
  return slackOk({
    messages: input.messages ?? [
      { ts: TEST_MESSAGE_TS, text: "hello", user: TEST_USER_ID },
    ],
    has_more: nextCursor.length > 0,
    response_metadata: {
      next_cursor: nextCursor,
    },
  });
}

export function conversationsRepliesPage(
  input: {
    messages?: Array<Record<string, unknown>>;
    nextCursor?: string;
    threadTs?: string;
  } = {},
): {
  ok: true;
  messages: Array<Record<string, unknown>>;
  has_more: boolean;
  response_metadata: { next_cursor: string };
} {
  const nextCursor = input.nextCursor ?? "";
  return slackOk({
    messages: input.messages ?? [
      {
        ts: input.threadTs ?? TEST_THREAD_TS,
        thread_ts: input.threadTs ?? TEST_THREAD_TS,
        user: TEST_USER_ID,
        text: "root",
      },
      {
        ts: slackTimestamp(1),
        thread_ts: input.threadTs ?? TEST_THREAD_TS,
        user: TEST_USER_ID,
        text: "reply",
      },
    ],
    has_more: nextCursor.length > 0,
    response_metadata: {
      next_cursor: nextCursor,
    },
  });
}

export function canvasesCreateOk(input: { canvasId?: string } = {}): {
  ok: true;
  canvas_id: string;
} {
  return slackOk({
    canvas_id: input.canvasId ?? TEST_CANVAS_ID,
  });
}

export function conversationsCanvasesCreateOk(
  input: { canvasId?: string } = {},
): { ok: true; canvas_id: string } {
  return canvasesCreateOk(input);
}

export function canvasesSectionsLookupOk(
  input: {
    sectionId?: string;
    containsText?: string;
  } = {},
): { ok: true; sections: Array<{ id: string; type: string; text: string }> } {
  return slackOk({
    sections: [
      {
        id: input.sectionId ?? TEST_SECTION_ID,
        type: "rich_text",
        text: input.containsText ?? "section",
      },
    ],
  });
}

export function canvasesEditOk(): { ok: true } {
  return slackOk();
}

export function slackListsCreateOk(
  input: {
    listId?: string;
    titleColumnId?: string;
    completedColumnId?: string;
    assigneeColumnId?: string;
    dueDateColumnId?: string;
  } = {},
): {
  ok: true;
  list_id: string;
  list_metadata: {
    schema: Array<{
      id: string;
      key: string;
      name: string;
      type: string;
      is_primary_column?: boolean;
    }>;
  };
} {
  return slackOk({
    list_id: input.listId ?? TEST_LIST_ID,
    list_metadata: {
      schema: [
        {
          id: input.titleColumnId ?? "COL_TITLE",
          key: "task",
          name: "Task",
          type: "rich_text",
          is_primary_column: true,
        },
        {
          id: input.completedColumnId ?? "COL_DONE",
          key: "completed",
          name: "Completed",
          type: "checkbox",
        },
        {
          id: input.assigneeColumnId ?? "COL_ASSIGNEE",
          key: "assignee",
          name: "Assignee",
          type: "user",
        },
        {
          id: input.dueDateColumnId ?? "COL_DUE",
          key: "due_date",
          name: "Due Date",
          type: "date",
        },
      ],
    },
  });
}

export function slackListsItemsCreateOk(input: { itemId?: string } = {}): {
  ok: true;
  item: { id: string };
} {
  return slackOk({
    item: {
      id: input.itemId ?? "ROW_1",
    },
  });
}

export function slackListsItemsListPage(
  input: {
    items?: Array<Record<string, unknown>>;
    nextCursor?: string;
  } = {},
): {
  ok: true;
  items: Array<Record<string, unknown>>;
  response_metadata: { next_cursor: string };
} {
  return slackOk({
    items: input.items ?? [{ id: "ROW_1", fields: [] }],
    response_metadata: {
      next_cursor: input.nextCursor ?? "",
    },
  });
}

export function slackListsItemsUpdateOk(): { ok: true } {
  return slackOk();
}

export function filesInfoOk(
  input: { fileId?: string; permalink?: string } = {},
): {
  ok: true;
  file: { id: string; permalink: string };
} {
  return slackOk({
    file: {
      id: input.fileId ?? TEST_FILE_ID,
      permalink:
        input.permalink ??
        `https://example.invalid/files/${input.fileId ?? TEST_FILE_ID}`,
    },
  });
}

export function filesGetUploadUrlOk(
  input: { fileId?: string; uploadUrl?: string } = {},
): {
  ok: true;
  file_id: string;
  upload_url: string;
} {
  return slackOk({
    file_id: input.fileId ?? TEST_FILE_ID,
    upload_url:
      input.uploadUrl ??
      `https://files.slack.com/upload/v1/${input.fileId ?? TEST_FILE_ID}`,
  });
}

export function filesCompleteUploadOk(
  input: {
    files?: Array<Record<string, unknown>>;
  } = {},
): { ok: true; files: Array<Record<string, unknown>> } {
  return slackOk({
    files: input.files ?? [{ id: TEST_FILE_ID }],
  });
}

export function usersInfoOk(
  input: {
    userId?: string;
    userName?: string;
    realName?: string;
    displayName?: string;
  } = {},
): {
  ok: true;
  user: {
    id: string;
    name: string;
    real_name: string;
    profile: { display_name: string; real_name: string };
  };
} {
  return slackOk({
    user: {
      id: input.userId ?? TEST_USER_ID,
      name: input.userName ?? "testuser",
      real_name: input.realName ?? "Test User",
      profile: {
        display_name: input.displayName ?? "Test User",
        real_name: input.realName ?? "Test User",
      },
    },
  });
}
