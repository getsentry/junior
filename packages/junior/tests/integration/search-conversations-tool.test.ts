import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { appendConversationBrief } from "@/chat/briefs/store";
import { createPluginConversations } from "@/chat/conversations/plugin-search";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { createSlackConversationSearchChannelPort } from "@/chat/slack/tools/conversation-search";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createSearchConversationsTool } from "@/chat/tools/search-conversations";
import { juniorConversations } from "@/db/schema";
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

  it("lets plugin tools find other Conversations by Annotation", async () => {
    const key = "getsentry/junior#691";
    const db = getDb();
    const nowMs = Date.now();
    const hourAgoMs = nowMs - 60 * 60 * 1000;
    const monthAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    const annotate = async (conversationId: string) =>
      await createPluginAnnotations({
        conversationId,
        db,
        plugin: "github",
      }).upsert({
        kind: "resource_link",
        key,
        label: key,
        url: "https://github.com/getsentry/junior/pull/691",
      });
    const record = async (args: {
      activityAtMs: number;
      archived?: boolean;
      channelId: string;
      status?: "failed" | "running";
      summary?: string;
      visibility: "private" | "public";
    }) => {
      const conversationId = `slack:${args.channelId}:1700000000.100000`;
      await getConversationStore().recordActivity({
        conversationId,
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: args.channelId,
        },
        nowMs: args.activityAtMs,
        source: "slack",
        title: `Work in ${args.channelId}`,
        visibility: args.visibility,
      });
      await annotate(conversationId);
      await db
        .update(juniorConversations)
        .set({
          archivedAt: args.archived ? new Date(args.activityAtMs) : null,
          executionStatus: args.status ?? "idle",
        })
        .where(eq(juniorConversations.conversationId, conversationId));
      if (args.summary) {
        await appendConversationBrief(db, {
          conversationId,
          turnId: `${args.channelId}-turn`,
          throughSeq: 1,
          content: conversationBriefFixture({ summary: args.summary }),
          searchText: args.summary,
          modelId: "test-model",
        });
      }
      return conversationId;
    };
    const requester = await record({
      activityAtMs: nowMs,
      channelId: "CREQUEST",
      visibility: "public",
    });
    // The requester's own child agent touched the pull request too.
    const ownChild = "agent:own-child";
    await getConversationStore().createChild({
      childConversationId: ownChild,
      kind: "task",
      parentConversationId: requester,
      nowMs,
      source: "slack",
    });
    await annotate(ownChild);
    const working = await record({
      activityAtMs: hourAgoMs,
      channelId: "CWORKING",
      status: "running",
      summary: "Fixing the flaky test on the pull request.",
      visibility: "public",
    });
    // Older than a week and not archived: still a match.
    const old = await record({
      activityAtMs: monthAgoMs,
      channelId: "COLD",
      status: "failed",
      visibility: "public",
    });
    await record({
      activityAtMs: nowMs,
      channelId: "CPRIVATE",
      visibility: "private",
    });
    await record({
      activityAtMs: nowMs,
      archived: true,
      channelId: "CARCHIVED",
      visibility: "public",
    });

    const conversations = createPluginConversations(ownChild);

    await expect(conversations.search({ annotation: key })).resolves.toEqual([
      {
        conversationId: working,
        status: "running",
        summary: "Fixing the flaky test on the pull request.",
        title: "Work in CWORKING",
        updatedAt: new Date(hourAgoMs).toISOString(),
      },
      // A failed Turn waits for new input.
      {
        conversationId: old,
        status: "idle",
        title: "Work in COLD",
        updatedAt: new Date(monthAgoMs).toISOString(),
      },
    ]);
  });
});
