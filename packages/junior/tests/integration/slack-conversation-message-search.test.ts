import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessageSearchScope } from "@/chat/conversations/message-search";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import { createSlackConversationMessageSearchTool } from "@/chat/slack/tools/conversation-message-search";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { chatGetPermalinkOk } from "../fixtures/slack/factories/api";
import { queueSlackApiResponse } from "../msw/handlers/slack-api";

const scope: ConversationMessageSearchScope = {
  kind: "public_provider_tenant",
  provider: "slack",
  providerTenantId: "T123",
};

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("searchConversationMessages", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("searches the authorized public workspace and returns cross-channel permalinks", async () => {
    const conversations = getConversationStore();
    const events = getConversationEventStore();
    await conversations.recordActivity({
      conversationId: "slack:CARCHIVE:1700000000.100000",
      channelName: "archive",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "CARCHIVE",
      },
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
      source: "slack",
      visibility: "public",
    });
    await events.append("slack:CARCHIVE:1700000000.100000", [
      {
        data: {
          type: "message",
          messageId: "1700000000.100001",
          role: "user",
          text: "We decided the launch checklist needs a rollback owner.",
        },
        createdAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
      },
    ]);
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
      }),
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
      }),
    });
    const tool = createSlackConversationMessageSearchTool(
      scope,
      "slack:CREQUEST:1700000000.900000",
    );

    const result = await executeTool(tool, {
      query: "launch checklist",
      channel_id: null,
      limit: null,
    });

    expect(result).toEqual({
      query: "launch checklist",
      count: 1,
      matches: [
        {
          conversation_id: "slack:CARCHIVE:1700000000.100000",
          thread_ts: "1700000000.100000",
          message_id: "1700000000.100001",
          message_role: "user",
          message_timestamp: "2026-07-01T12:00:00.000Z",
          excerpt: expect.stringContaining("rollback owner"),
          channel_id: "CARCHIVE",
          channel_name: "archive",
          permalink:
            "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
        },
      ],
    });

    const filtered = await executeTool(tool, {
      channel_id: "CARCHIVE",
      query: null,
      limit: null,
    });
    expect(filtered).toEqual({
      channel_id: "CARCHIVE",
      count: 1,
      matches: [
        expect.objectContaining({
          channel_id: "CARCHIVE",
          conversation_id: "slack:CARCHIVE:1700000000.100000",
        }),
      ],
    });

    await expect(
      executeTool(tool, {
        channel_id: null,
        query: null,
        limit: null,
      }),
    ).rejects.toBeInstanceOf(ToolInputError);

    await expect(
      executeTool(tool, {
        channel_id: "not-a-channel",
        query: null,
        limit: null,
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
