import { afterEach, describe, expect, it } from "vitest";
import type { ConversationBriefSearchScope } from "@/chat/briefs/search";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/slack/dashboard-link";
import { createSearchConversationBriefsTool } from "@/chat/tools/search-conversation-briefs";
import { conversationBriefFixture } from "../fixtures/conversation-brief";
import {
  chatGetPermalinkOk,
  slackError,
} from "../fixtures/slack/factories/api";
import { queueSlackApiResponse } from "../msw/handlers/slack-api";

const scope: ConversationBriefSearchScope = {
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

describe("searchConversationBriefs", () => {
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

    const tool = createSearchConversationBriefsTool(
      scope,
      "slack:CREQUEST:1700000000.900000",
    );
    const result = await executeTool(tool, {
      after: null,
      annotation: null,
      before: null,
      channel_id: null,
      limit: null,
      query: "launch decision",
      status: "done",
    });

    expect(result).toEqual({
      count: 1,
      matches: [
        {
          channel_id: "CARCHIVE",
          channel_name: "archive",
          conversation_id: conversationId,
          dashboard_url: `https://junior.example.com/conversations/${encodeURIComponent(conversationId)}`,
          excerpt: expect.stringContaining("**launch**"),
          links: [
            {
              kind: "code_change",
              label: "getsentry/junior#1805",
              status: "open",
              url: "https://github.com/getsentry/junior/pull/1805",
            },
          ],
          permalink:
            "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
          status: "done",
          summary: "The launch decision uses a blue rollout.",
          title: "Launch decision",
          updated_at: expect.any(String),
          version: 1,
        },
      ],
      query: "launch decision",
      status: "done",
    });

    queueSlackApiResponse("chat.getPermalink", {
      body: slackError({ error: "missing_scope" }),
    });
    const resultWithoutPermalink = await executeTool(tool, {
      query: "launch decision",
    });
    expect(resultWithoutPermalink.matches[0]).not.toHaveProperty("permalink");

    const publicTool = createSearchConversationBriefsTool(
      { kind: "public" },
      "local:test:current",
    );
    await expect(
      executeTool(publicTool, { channel_id: "CARCHIVE" }),
    ).rejects.toThrow("channel_id is available only in Slack searches");
  });
});
