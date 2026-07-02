import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackThreadReadTool } from "@/chat/tools/slack/thread-read";
import type { DestinationVisibilityReader } from "@/chat/tools/slack/channel-access";
import type { SlackToolContext } from "@/chat/tools/slack/context";
import { conversationsRepliesPage } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createContext(
  overrides: Partial<SlackToolContext> = {},
): SlackToolContext {
  const sourceChannelId = overrides.sourceChannelId ?? "C_CURRENT";
  const destinationChannelId =
    overrides.destinationChannelId ?? sourceChannelId;
  return {
    destination: overrides.destination ?? {
      platform: "slack",
      teamId: "T123",
      channelId: destinationChannelId,
    },
    source:
      overrides.source ??
      createSlackSource({
        teamId: "T123",
        channelId: sourceChannelId,

        type: "priv",
      }),
    destinationChannelId,
    sourceChannelId,
    teamId: "T123",
    ...overrides,
  };
}

/** Persisted-visibility fake: only listed channels are public in T123. */
function persistedPublicChannels(
  ...channelIds: string[]
): DestinationVisibilityReader {
  return {
    async getDestinationVisibility(args) {
      if (args.provider !== "slack" || args.providerTenantId !== "T123") {
        return undefined;
      }
      return channelIds.includes(args.providerDestinationId)
        ? "public"
        : undefined;
    },
  };
}

function createTool(
  overrides: Partial<SlackToolContext> = {},
  publicChannels: string[] = [],
) {
  return createSlackThreadReadTool(createContext(overrides), {
    visibilityStore: persistedPublicChannels(...publicChannels),
  });
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slackThreadRead", () => {
  it("reads a thread from a public channel URL", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.123456",
        messages: [
          {
            ts: "1700000000.123456",
            thread_ts: "1700000000.123456",
            user: "U1",
            text: "root message",
          },
          {
            ts: "1700000000.200000",
            thread_ts: "1700000000.123456",
            user: "U2",
            text: "reply message",
          },
        ],
      }),
    });

    const tool = createTool({}, ["C0AHB7N2JCR"]);
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000123456",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C0AHB7N2JCR",
      target_message_ts: "1700000000.123456",
      thread_ts: "1700000000.123456",
      count: 2,
      fetched_count: 2,
      truncated: false,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text).toBe("root message");
    expect(result.messages[1].text).toBe("reply message");

    // No conversations.info call — access determined by persisted visibility
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("uses thread_ts from the URL when present", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.000000",
            thread_ts: "1700000000.000000",
            user: "U1",
            text: "thread root",
          },
          {
            ts: "1700000000.999999",
            thread_ts: "1700000000.000000",
            user: "U2",
            text: "the linked reply",
          },
        ],
      }),
    });

    const tool = createTool({}, ["C123"]);
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000999999?thread_ts=1700000000.000000&cid=C123",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      target_message_ts: "1700000000.999999",
      thread_ts: "1700000000.000000",
      count: 2,
    });

    expect(
      getCapturedSlackApiCalls("conversations.replies")[0]?.params,
    ).toMatchObject({
      channel: "C123",
      ts: "1700000000.000000",
    });
  });

  it("reads a thread from explicit channel_id and ts", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.500000",
        messages: [
          {
            ts: "1700000000.500000",
            thread_ts: "1700000000.500000",
            user: "U1",
            text: "standalone message",
          },
        ],
      }),
    });

    const tool = createTool({}, ["C_MANUAL"]);
    const result = await executeTool(tool, {
      channel_id: "C_MANUAL",
      ts: "1700000000.500000",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C_MANUAL",
      count: 1,
    });
    expect(result.messages[0].text).toBe("standalone message");
  });

  it("allows reading a private channel when it matches the current channel", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "private but same channel",
          },
        ],
      }),
    });

    const tool = createTool({ sourceChannelId: "G_PRIVATE" });
    const result = await executeTool(tool, {
      channel_id: "G_PRIVATE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "G_PRIVATE",
      count: 1,
    });

    // No extra API call for same-channel private reads
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("reads a private group channel from assistant context during DM turns", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "private context root",
          },
        ],
      }),
    });

    const tool = createTool({
      sourceChannelId: "D_DM",
      destinationChannelId: "G_PRIVATE",
    });
    const result = await executeTool(tool, {
      channel_id: "G_PRIVATE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "G_PRIVATE",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("blocks reading a private group channel from a DM conversation without assistant context", async () => {
    const tool = createTool({ sourceChannelId: "D_DM" });
    const result = await executeTool(tool, {
      channel_id: "G_PRIVATE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "G_PRIVATE",
    });
    expect(result.error).toContain("current conversation");
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a private channel that is not the current channel", async () => {
    const tool = createTool({ sourceChannelId: "C_CURRENT" });
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/G0OTHER/p1700000000100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "G0OTHER",
      target_message_ts: "1700000000.100000",
    });
    expect(result.error).toContain("current conversation");

    // Should NOT call any Slack API — blocked locally
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a DM channel that is not the current channel", async () => {
    const tool = createTool();
    const result = await executeTool(tool, {
      channel_id: "D_SOMEONE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "D_SOMEONE",
    });
    expect(result.error).toContain("current conversation");
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a C-prefixed channel without persisted public visibility", async () => {
    const tool = createTool({ sourceChannelId: "C_CURRENT" });
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0UNCONFIRMED/p1700000000100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "C0UNCONFIRMED",
    });
    expect(result.error).toContain("public channels Junior has seen");
    // Blocked locally, no Slack API traffic.
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("returns a recoverable error when conversations.replies fails", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });

    const tool = createTool({}, ["C_FLAKY"]);
    const result = await executeTool(tool, {
      channel_id: "C_FLAKY",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "C_FLAKY",
      slack_error: "not_in_channel",
    });
    expect(result.error).toContain("Could not read this Slack thread");
  });

  it("returns an error for invalid URL input", async () => {
    const tool = createTool();
    const result = await executeTool(tool, {
      url: "not a valid url",
    });

    expect(result).toEqual({
      ok: false,
      error: "Input is not a valid URL",
    });
  });

  it("returns an error when neither url nor channel_id+ts are provided", async () => {
    const tool = createTool();
    const result = await executeTool(tool, {});

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Provide either"),
    });
  });

  it("rejects invalid explicit ts format", async () => {
    const tool = createTool();
    const result = await executeTool(tool, {
      channel_id: "C123",
      ts: "not-a-timestamp",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Invalid Slack message timestamp.",
    });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("paginates across multiple reply pages", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.000000",
            thread_ts: "1700000000.000000",
            user: "U1",
            text: "root",
          },
          {
            ts: "1700000000.001000",
            thread_ts: "1700000000.000000",
            user: "U2",
            text: "reply-1",
          },
        ],
        nextCursor: "page-2-cursor",
      }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.000000",
        messages: [
          {
            ts: "1700000000.002000",
            thread_ts: "1700000000.000000",
            user: "U3",
            text: "reply-2",
          },
        ],
      }),
    });

    const tool = createTool({}, ["C_PAGED"]);
    const result = await executeTool(tool, {
      channel_id: "C_PAGED",
      ts: "1700000000.000000",
    });

    expect(result).toMatchObject({
      ok: true,
      count: 3,
      fetched_count: 3,
      truncated: false,
    });
    expect(result.messages).toHaveLength(3);

    const calls = getCapturedSlackApiCalls("conversations.replies");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({
      cursor: "page-2-cursor",
    });
  });

  it("strips private file URLs from returned messages", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "message with file",
            files: [
              {
                id: "F123",
                name: "secret.pdf",
                mimetype: "application/pdf",
                size: 12345,
                url_private: "https://files.slack.com/secret-url",
                url_private_download: "https://files.slack.com/secret-dl",
              },
            ],
          },
        ],
      }),
    });

    const tool = createTool({}, ["C123"]);
    const result = await executeTool(tool, {
      channel_id: "C123",
      ts: "1700000000.100000",
    });

    expect(result.ok).toBe(true);
    const file = result.messages[0].files[0];
    expect(file).toEqual({
      id: "F123",
      name: "secret.pdf",
      mimetype: "application/pdf",
      size: 12345,
    });
    expect(file).not.toHaveProperty("url_private");
    expect(file).not.toHaveProperty("url_private_download");
  });

  it("does not call conversations.history — only conversations.replies", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "msg",
          },
        ],
      }),
    });

    const tool = createTool({}, ["C123"]);
    await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000100000",
    });

    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });
});
