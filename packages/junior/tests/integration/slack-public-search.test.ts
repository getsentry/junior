import { describe, expect, it } from "vitest";
import { readSlackActionToken } from "@/chat/slack/action-token";
import { createSlackPublicSearchTool } from "@/chat/slack/tools/public-search";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

const actionToken = readSlackActionToken({
  raw: { action_token: "action-123" },
});
if (!actionToken) {
  throw new Error("test action token did not parse");
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("Slack public search", () => {
  it("searches public messages with the active action token and returns permalinks", async () => {
    queueSlackApiResponse("assistant.search.context", {
      body: {
        ok: true,
        results: {
          messages: [
            {
              author_name: "Ada Lovelace",
              author_user_id: "U123",
              channel_id: "C123",
              channel_name: "announcements",
              message_ts: "1784000000.000100",
              content: "Project Gizmo shipped.",
              is_author_bot: false,
              permalink:
                "https://example.slack.com/archives/C123/p1784000000000100",
            },
          ],
          next_cursor: "next-page",
        },
      },
    });

    const result = await executeTool(createSlackPublicSearchTool(actionToken), {
      query: "project gizmo",
      after: 1783900000,
      limit: 5,
      sort: "timestamp",
      sort_dir: "desc",
    });

    expect(result).toMatchObject({
      query: "project gizmo",
      content_types: ["messages"],
      count: 1,
      next_cursor: "next-page",
      messages: [
        {
          channel_id: "C123",
          channel_name: "announcements",
          content: "Project Gizmo shipped.",
          permalink:
            "https://example.slack.com/archives/C123/p1784000000000100",
        },
      ],
      files: [],
      channels: [],
      users: [],
    });
    expect(
      getCapturedSlackApiCalls("assistant.search.context")[0]?.params,
    ).toMatchObject({
      action_token: "action-123",
      query: "project gizmo",
      channel_types: ["public_channel"],
      content_types: ["messages"],
      include_bots: "true",
      after: "1783900000",
      limit: "5",
      sort: "timestamp",
      sort_dir: "desc",
    });
  });

  it("searches files and users when those content types are requested", async () => {
    queueSlackApiResponse("assistant.search.context", {
      body: {
        ok: true,
        results: {
          messages: [],
          files: [
            {
              id: "F123",
              title: "gizmo plan",
              name: "gizmo.pdf",
              filetype: "pdf",
              user: "U9",
              channel_id: "C123",
              permalink: "https://example.slack.com/files/U9/F123/gizmo.pdf",
            },
          ],
          users: [
            {
              id: "U9",
              name: "ada",
              real_name: "Ada Lovelace",
              display_name: "ada",
            },
          ],
        },
      },
    });

    const result = await executeTool(createSlackPublicSearchTool(actionToken), {
      query: "gizmo",
      content_types: ["files", "users"],
    });

    expect(result).toMatchObject({
      query: "gizmo",
      content_types: ["files", "users"],
      count: 2,
      files: [
        {
          file_id: "F123",
          title: "gizmo plan",
          name: "gizmo.pdf",
          filetype: "pdf",
          user_id: "U9",
          channel_id: "C123",
          permalink: "https://example.slack.com/files/U9/F123/gizmo.pdf",
        },
      ],
      users: [
        {
          user_id: "U9",
          user_name: "ada",
          real_name: "Ada Lovelace",
          display_name: "ada",
        },
      ],
      messages: [],
      channels: [],
    });
    expect(
      getCapturedSlackApiCalls("assistant.search.context")[0]?.params,
    ).toMatchObject({
      content_types: ["files", "users"],
    });
  });

  it("omits empty timestamp bounds instead of coercing them to epoch", async () => {
    queueSlackApiResponse("assistant.search.context", {
      body: { ok: true, results: { messages: [] } },
    });

    await executeTool(createSlackPublicSearchTool(actionToken), {
      query: "company announcement",
      after: "",
      before: "   ",
    });

    const params = getCapturedSlackApiCalls("assistant.search.context")[0]
      ?.params;
    expect(params).not.toHaveProperty("after");
    expect(params).not.toHaveProperty("before");
  });

  it("reports a missing public-search scope explicitly", async () => {
    queueSlackApiError("assistant.search.context", {
      error: "missing_scope",
      needed: "search:read.public",
    });

    await expect(
      executeTool(createSlackPublicSearchTool(actionToken), {
        query: "company announcement",
      }),
    ).rejects.toThrow(
      "Public Slack search is unavailable because this installation is missing the `search:read.public` scope.",
    );
  });

  it("explains the interactive action-token limit when no token is available", async () => {
    await expect(
      executeTool(createSlackPublicSearchTool(undefined), {
        query: "company announcement",
      }),
    ).rejects.toThrow("fresh interactive mention");
  });

  it("reports a missing files search scope explicitly", async () => {
    queueSlackApiError("assistant.search.context", {
      error: "missing_scope",
      needed: "search:read.files",
    });

    await expect(
      executeTool(createSlackPublicSearchTool(actionToken), {
        query: "roadmap pdf",
        content_types: ["files"],
      }),
    ).rejects.toThrow(
      "Public Slack search is unavailable because this installation is missing the `search:read.files` scope.",
    );
  });
});
