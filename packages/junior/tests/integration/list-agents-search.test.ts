import { asc, eq } from "drizzle-orm";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { runConversationEmbeddingBackfill } from "@/chat/conversations/embedding-backfill";
import { createPluginConversations } from "@/chat/conversations/plugin-search";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { createSlackConversationSearchChannelPort } from "@/chat/slack/tool-support/conversation-search";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { juniorConversationEmbeddings, juniorConversations } from "@/db/schema";
import { slackSpawnInput } from "../fixtures/child-agents";
import { startChildAgent } from "../fixtures/child-agent-start";
import { storeConversationMetadataFixture } from "../fixtures/conversation-metadata";
import { seedMcpConversation } from "../fixtures/mcp-tools";
import { createHarness } from "../fixtures/thread-input";
import { signedInViewer } from "../fixtures/user";
import { patchConfig } from "../fixtures/config";
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

describe("listAgents query", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("finds Conversations that it may read, its team first, then its person's, and says how much of a summary it cut", async () => {
    const recordPublic = async (channelId: string, title: string) => {
      const conversationId = `slack:${channelId}:1700000000.100000`;
      await getConversationStore().recordActivity({
        conversationId,
        destination: { platform: "slack", teamId: "T123", channelId },
        nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
        source: "slack",
        title,
        visibility: "public",
      });
      return conversationId;
    };
    const other = await recordPublic("CARCHIVE", "Launch decision");
    const summary = `The launch decision uses a blue rollout. ${"More detail. ".repeat(100)}`;
    await storeConversationMetadataFixture(getDb(), {
      conversationId: other,
      summary,
      throughSeq: 1,
    });
    await getConversationStore().recordActivity({
      conversationId: "slack:CPRIVATE:1700000000.100000",
      destination: { platform: "slack", teamId: "T123", channelId: "CPRIVATE" },
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
      source: "slack",
      title: "Launch decision in private",
      visibility: "private",
    });
    const requester = await recordPublic("CREQUEST", "Planning");
    // An older child agent of the requester still ranks first.
    const harness = await createHarness();
    let child: string;
    try {
      child = await startChildAgent({
        actor: slackSpawnInput.actor,
        conversationStore: harness.conversationStore,
        idempotencyKey: "launch-child",
        kind: "thread",
        nowMs: Date.parse("2026-06-01T12:00:00.000Z"),
        parentConversationId: requester,
        queue: harness.queue,
        state: harness.state,
        title: "Launch decision follow-up",
      });
    } finally {
      await harness.close();
    }
    // Its person takes part in this one. It matches the query less closely
    // than the other public match and still ranks before it.
    const person = await signedInViewer("list-agents-person@example.com");
    const personWork = "slack:CPERSON:1700000000.100000";
    await seedMcpConversation({
      conversationId: personWork,
      email: "list-agents-person@example.com",
      title: "Launch window and the decision log",
    });
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });

    const tool = createListAgentsTool({
      conversationId: requester,
      resolvePersonUserId: async () => person.id,
    });
    // Default values and a limit alone still list the team.
    expect(
      await executeTool(tool, {
        include_archived: false,
        limit: 10,
        participating: false,
        roots_only: true,
      }),
    ).toEqual(await executeTool(tool, {}));
    const result = await executeTool(tool, { query: "launch decision" });

    expect(result.agents).toEqual([
      expect.objectContaining({
        relation: "child",
        conversation_id: child,
        kind: "thread",
      }),
      expect.objectContaining({
        relation: "other",
        conversation_id: personWork,
      }),
      {
        relation: "other",
        conversation_id: other,
        excerpt: expect.stringContaining("**launch**"),
        kind: "thread",
        status: "idle",
        summary: expect.stringMatching(
          /… \[\d+ more characters cut\. Read the conversation with searchConversationEvents\.\]$/,
        ),
        title: "Launch decision",
        updated_at: expect.any(String),
        url: `https://junior.example.com/conversations/${encodeURIComponent(other)}`,
        // Its updates do not reach the requester, so it offers a Watch.
        subscribable: {
          identifier: other,
          label: "Conversation Launch decision",
          namespace: "junior",
          supported_events: ["agent.update"],
          suggested_events: ["agent.update"],
          type: "agent",
        },
      },
    ]);
    expect(result.agents[0]).not.toHaveProperty("subscribable");
    const cut = /\[(\d+) more characters cut/.exec(
      result.agents[2].summary,
    )?.[1];
    expect(result.agents[2].summary.startsWith(summary.slice(0, 1_000))).toBe(
      true,
    );
    expect(Number(cut)).toBe(summary.length - 1_000);
  });

  it("returns bounded summary details with a dashboard link, else a best-effort Slack link", async () => {
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
    await storeConversationMetadataFixture(getDb(), {
      conversationId,
      summary: "The launch decision uses a blue rollout.",
      throughSeq: 1,
    });
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert({
      kind: "resource_link",
      key: "getsentry/junior#1805",
      label: "getsentry/junior#1805",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/1805",
    });
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });

    const tool = createListAgentsTool({
      channels,
      conversationId: "slack:CREQUEST:1700000000.900000",
    });
    expect(tool.inputSchema["properties"]).toHaveProperty("channel_id");
    const result = await executeTool(tool, {
      after: null,
      annotation: null,
      before: null,
      channel_id: null,
      limit: null,
      query: "launch decision",
    });

    expect(result).toEqual({
      agents: [
        {
          relation: "other",
          channel_id: "CARCHIVE",
          channel_name: "archive",
          conversation_id: conversationId,
          excerpt: expect.stringContaining("**launch**"),
          kind: "thread",
          links: [
            {
              label: "getsentry/junior#1805",
              status: "open",
              url: "https://github.com/getsentry/junior/pull/1805",
            },
          ],
          status: "idle",
          summary: "The launch decision uses a blue rollout.",
          subscribable: expect.objectContaining({ identifier: conversationId }),
          title: "Launch decision",
          updated_at: expect.any(String),
          url: `https://junior.example.com/conversations/${encodeURIComponent(conversationId)}`,
        },
      ],
    });

    // Without the dashboard, the Slack thread is the link.
    patchConfig({ dashboard: undefined });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink:
          "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
      }),
    });
    const resultWithThreadUrl = await executeTool(tool, {
      query: "launch decision",
    });
    expect(resultWithThreadUrl.agents[0]).toMatchObject({
      url: "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
    });

    queueSlackApiResponse("chat.getPermalink", {
      body: slackError({ error: "missing_scope" }),
    });
    const resultWithoutUrl = await executeTool(tool, {
      query: "launch decision",
    });
    expect(resultWithoutUrl.agents[0]).not.toHaveProperty("url");

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
    expect(childResult.agents).toEqual([
      expect.objectContaining({
        channel_id: "CARCHIVE",
        channel_name: "archive",
        conversation_id: childId,
        kind: "thread",
        url: "https://example.slack.com/archives/CARCHIVE/p1700000000100000",
        root_conversation_id: conversationId,
      }),
    ]);

    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });
    const publicTool = createListAgentsTool({
      conversationId: "local:test:current",
    });
    expect(publicTool.inputSchema["properties"]).not.toHaveProperty(
      "channel_id",
    );
    expect(() =>
      publicTool.prepareArguments({ channel_id: "CARCHIVE" }),
    ).toThrow("Invalid tool arguments");
    const publicResult = await executeTool(publicTool, {
      query: "launch decision",
    });
    expect(publicResult.agents[0]).toMatchObject({
      conversation_id: conversationId,
      url: `https://junior.example.com/conversations/${encodeURIComponent(conversationId)}`,
    });
    expect(publicResult.agents[0]).not.toHaveProperty("channel_id");
    expect(publicResult.agents[0]).not.toHaveProperty("channel_name");
  });

  it("embeds summaries again after a model change, so search finds them by meaning", async () => {
    const db = getDb();
    const record = async (channelId: string, summary: string) => {
      const conversationId = `slack:${channelId}:1700000000.100000`;
      await getConversationStore().recordActivity({
        conversationId,
        destination: { platform: "slack", teamId: "T123", channelId },
        nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
        source: "slack",
        title: `Title for ${channelId}`,
        visibility: "public",
      });
      await storeConversationMetadataFixture(db, {
        conversationId,
        summary,
        throughSeq: 1,
      });
      // The vector of the model before the change.
      await db.insert(juniorConversationEmbeddings).values({
        conversationId,
        dimensions: 3,
        embedding: [1, 0, 0],
        model: "retired-embedding-model",
        provider: "vercel-ai-gateway",
        throughSeq: 1,
      });
      return conversationId;
    };
    const kafka = await record("CKAFKA", "Kafka consumer lag spiked");
    const lunch = await record("CLUNCH", "Team lunch moved to Friday");

    // The fake model puts text about message queues on one axis.
    const requests: string[][] = [];
    const embedder: PluginEmbedder = {
      model: "current-embedding-model",
      provider: "vercel-ai-gateway",
      async embedTexts({ texts }) {
        requests.push(texts);
        return {
          dimensions: 2,
          model: "current-embedding-model",
          provider: "vercel-ai-gateway",
          vectors: texts.map((text) =>
            /kafka|queue/i.test(text) ? [1, 0] : [0, 1],
          ),
        };
      },
    };

    await runConversationEmbeddingBackfill(embedder);
    await runConversationEmbeddingBackfill(embedder);

    // One batch for both summaries. The second run finds the model done.
    expect(requests).toEqual([
      [
        "Title for CKAFKA\nKafka consumer lag spiked",
        "Title for CLUNCH\nTeam lunch moved to Friday",
      ],
    ]);
    await expect(
      db
        .select({
          conversationId: juniorConversationEmbeddings.conversationId,
          dimensions: juniorConversationEmbeddings.dimensions,
          model: juniorConversationEmbeddings.model,
        })
        .from(juniorConversationEmbeddings)
        .orderBy(asc(juniorConversationEmbeddings.conversationId)),
    ).resolves.toEqual([
      {
        conversationId: kafka,
        dimensions: 2,
        model: "current-embedding-model",
      },
      {
        conversationId: lunch,
        dimensions: 2,
        model: "current-embedding-model",
      },
    ]);

    const tool = createListAgentsTool({
      conversationId: "local:test:embedding-requester",
      embedder,
    });
    // No summary has these words. Only the new vectors match.
    const result = await executeTool(tool, { query: "message queue backlog" });
    expect(result.agents).toEqual([
      expect.objectContaining({ conversation_id: kafka }),
    ]);
  });

  it("lets plugin tools find other Conversations by Annotation", async () => {
    const key = "getsentry/junior#691";
    const db = getDb();
    const nowMs = Date.now();
    const hourAgoMs = nowMs - 60 * 60 * 1000;
    const minuteAgoMs = nowMs - 60 * 1000;
    const monthAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    const twoMonthsAgoMs = nowMs - 60 * 24 * 60 * 60 * 1000;
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
      annotated?: boolean;
      archived?: boolean;
      channelId: string;
      status?: "failed" | "paused" | "running";
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
      if (args.annotated !== false) await annotate(conversationId);
      await db
        .update(juniorConversations)
        .set({
          archivedAt: args.archived ? new Date(args.activityAtMs) : null,
          executionStatus: args.status ?? "idle",
        })
        .where(eq(juniorConversations.conversationId, conversationId));
      if (args.summary) {
        await storeConversationMetadataFixture(db, {
          conversationId,
          summary: args.summary,
          throughSeq: 1,
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
    // Its last activity is older than every idle match, and it still ranks
    // first.
    const working = await record({
      activityAtMs: twoMonthsAgoMs,
      channelId: "CWORKING",
      status: "paused",
      summary: "Fixing the flaky test on the pull request.",
      visibility: "public",
    });
    const newer = await record({
      activityAtMs: minuteAgoMs,
      channelId: "CNEWER",
      visibility: "public",
    });
    // A parent that works on other things is not listed for its child's
    // Annotation. The child is.
    const parent = await record({
      activityAtMs: nowMs,
      annotated: false,
      channelId: "CPARENT",
      status: "running",
      visibility: "public",
    });
    const otherChild = "agent:other-child";
    await getConversationStore().createChild({
      childConversationId: otherChild,
      kind: "task",
      parentConversationId: parent,
      nowMs: hourAgoMs,
      source: "slack",
      title: "Review the pull request",
    });
    await annotate(otherChild);
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

    const workingMatch = {
      conversationId: working,
      status: "paused",
      summary: "Fixing the flaky test on the pull request.",
      title: "Work in CWORKING",
      updatedAt: new Date(twoMonthsAgoMs).toISOString(),
    };
    await expect(conversations.search({ annotation: key })).resolves.toEqual([
      workingMatch,
      {
        conversationId: newer,
        status: "idle",
        title: "Work in CNEWER",
        updatedAt: new Date(minuteAgoMs).toISOString(),
      },
      {
        conversationId: otherChild,
        rootConversationId: parent,
        status: "idle",
        title: "Review the pull request",
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
    // Newer idle matches do not push a working one past the limit.
    await expect(
      conversations.search({ annotation: key, limit: 1 }),
    ).resolves.toEqual([workingMatch]);
  });
});
