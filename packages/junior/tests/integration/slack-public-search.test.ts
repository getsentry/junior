import { describe, expect, it } from "vitest";
import { createSlackPublicSearchTool } from "@/chat/slack/tools/public-search";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

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

    const result = await executeTool(
      createSlackPublicSearchTool("action-123"),
      {
        query: "project gizmo",
        after: 1783900000,
        limit: 5,
        sort: "timestamp",
        sort_dir: "desc",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "success",
      query: "project gizmo",
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

  it("reports a missing public-search scope explicitly", async () => {
    queueSlackApiError("assistant.search.context", {
      error: "missing_scope",
      needed: "search:read.public",
    });

    const result = await executeTool(
      createSlackPublicSearchTool("action-123"),
      {
        query: "company announcement",
      },
    );

    expect(result).toEqual({
      ok: false,
      status: "error",
      error:
        "Public Slack search is unavailable because this installation is missing the `search:read.public` scope.",
      query: "company announcement",
      count: 0,
      messages: [],
    });
  });
});
