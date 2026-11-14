import { afterEach, describe, expect, it } from "vitest";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { createSlackConversationSearchChannelPort } from "@/chat/slack/tools/conversation-search";
import { createSearchConversationsTool } from "@/chat/tools/search-conversations";
import { conversationBriefFixture } from "../fixtures/conversation-brief";
import {
  chatGetPermalinkOk,
  slackError,
} from "../fixtures/slack/factories/api";
import { queueSlackApiResponse } from "../msw/handlers/slack-api";

const teamId = parseSlackTeamId("T123");
if (!teamId) {
  throw new Error("test Slack team id did not parse");
}
const channels = createSlackConversationSearchChannelPort(teamId);

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("searchConversations", () => {
  afterEach(async () => {
    setDashboardConversationLinkOptions(undefined);
    await closeDb();
  });

  it("returns bounded Brief details with dashboard and best-effort Slack links", async () => {
    const conversationId = "slack:CARCHIVE:1700000000.100000";
    await getConversationStore().recordActivity({
      conversationId,
      channelName: "archive",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "CARCHIVE",
      },
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
      source: "slack",
      title: "Launch decision",
      visibility: "public",
    });
    await appendConversationBrief(getDb(), {
      conversationId,
      turnId: "turn-1",
      throughSeq: 1,
      content: conversationBriefFixture({
        links: [
          {
            kind: "code_change",
            label: "getsentry/junior#1805",
            status: "open",
            url: "https://github.com/getsentry/junior/pull/1805",
          },
        ],
        status: "done",
        summary: "The launch decision uses a blue rollout.",
      }),
      searchText: "launch decision blue rollout getsentry junior 1805",
      modelId: "test-model",
    });
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
      }),
    });

    const tool = createSearchConversationsTool({
      channels,
      conversationId: "slack:CREQUEST:1700000000.900000",
    });
    expect(tool.inputSchema.properties).toHaveProperty("channel_id");
    const result = await executeTool(tool, {
      after: null,
      annotation: null,
      before: null,
      channel_id: null,
      limit: null,
      outcome: "done",
      query: "launch decision",
    });

    expect(result).toEqual({
      conversations: [
        {
          channel_id: "CARCHIVE",
          channel_name: "archive",
          conversation_id: conversationId,
          dashboard_url: `https://junior.example.com/conversations/${encodeURIComponent(conversationId)}`,
          excerpt: expect.stringContaining("**launch**"),
          kind: "root",
          links: [
            {
              kind: "code_change",
              label: "getsentry/junior#1805",
              status: "open",
              url: "https://github.com/getsentry/junior/pull/1805",
            },
          ],
          outcome: "done",
          permalink:
            "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
          status: "idle",
          summary: "The launch decision uses a blue rollout.",
          title: "Launch decision",
          updated_at: expect.any(String),
        },
      ],
    });

    queueSlackApiResponse("chat.getPermalink", {
      body: slackError({ error: "missing_scope" }),
    });
    const resultWithoutPermalink = await executeTool(tool, {
      query: "launch decision",
    });
    expect(resultWithoutPermalink.conversations[0]).not.toHaveProperty(
      "permalink",
    );

    // A child agent gives the Slack channel and thread of its root.
    const childId = "agent:launch-child";
    await getConversationStore().createChild({
      childConversationId: childId,
      kind: "thread",
      parentConversationId: conversationId,
      nowMs: Date.parse("2026-07-01T12:01:00.000Z"),
      source: "slack",
      title: "Launch decision follow-up",
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
      }),
    });
    const childResult = await executeTool(tool, {
      query: "follow-up",
      roots_only: false,
    });
    expect(childResult.conversations).toEqual([
      expect.objectContaining({
        channel_id: "CARCHIVE",
        channel_name: "archive",
        conversation_id: childId,
        kind: "thread",
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
        root_conversation_id: conversationId,
      }),
    ]);

    const publicTool = createSearchConversationsTool({
      conversationId: "local:test:current",
    });
    expect(publicTool.inputSchema.properties).not.toHaveProperty("channel_id");
    expect(() =>
      publicTool.prepareArguments({ channel_id: "CARCHIVE" }),
    ).toThrow("Invalid tool arguments");
    const publicResult = await executeTool(publicTool, {
      query: "launch decision",
    });
    expect(publicResult.conversations[0]).toMatchObject({
      conversation_id: conversationId,
      dashboard_url: `https://junior.example.com/conversations/${encodeURIComponent(conversationId)}`,
    });
    expect(publicResult.conversations[0]).not.toHaveProperty("channel_id");
    expect(publicResult.conversations[0]).not.toHaveProperty("channel_name");
    expect(publicResult.conversations[0]).not.toHaveProperty("permalink");
  });
});
