import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore } from "@/chat/db";
import { createSlackThreadReadTool } from "@/chat/slack/tools/thread-read";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import {
  conversationsInfoOk,
  conversationsJoinOk,
  conversationsRepliesPage,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

type ContextOverrides = Omit<
  Partial<SlackToolContext>,
  "destinationChannelId" | "locationChannelId" | "teamId"
> & {
  destinationChannelId?: string;
  locationChannelId?: string;
  teamId?: string;
};

function requireSlackChannelId(value: string) {
  const channelId = parseSlackChannelId(value);
  if (!channelId) {
    throw new Error(`Invalid test Slack channel ID: ${value}`);
  }
  return channelId;
}

function requireSlackTeamId(value: string) {
  const teamId = parseSlackTeamId(value);
  if (!teamId) {
    throw new Error(`Invalid test Slack team ID: ${value}`);
  }
  return teamId;
}

function createContext(overrides: ContextOverrides = {}): SlackToolContext {
  const locationChannelId = requireSlackChannelId(
    overrides.locationChannelId ?? "C0CURRENT",
  );
  const destinationChannelId =
    overrides.destinationChannelId !== undefined
      ? requireSlackChannelId(overrides.destinationChannelId)
      : locationChannelId;
  const teamId = requireSlackTeamId(overrides.teamId ?? "T123");
  const {
    locationChannelId: _locationChannelId,
    destinationChannelId: _destinationChannelId,
    teamId: _teamId,
    ...rest
  } = overrides;
  return {
    destinationChannelId,
    locationChannelId,
    teamId,
    ...rest,
  };
}

function createTool(overrides: ContextOverrides = {}) {
  return createSlackThreadReadTool(createContext(overrides));
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slackThreadRead", () => {
  afterEach(async () => {
    await closeDb();
  });

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

    const tool = createTool({});
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0AHB7N2JCR/p1700000000123456",
    });

    expect(result).toMatchObject({
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

    // Live channel metadata may be fetched even when persisted public visibility exists.
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

    const tool = createTool({});
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000999999?thread_ts=1700000000.000000&cid=C123",
    });

    expect(result).toMatchObject({
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

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0MANUAL",
      ts: "1700000000.500000",
    });

    expect(result).toMatchObject({
      channel_id: "C0MANUAL",
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

    const tool = createTool({ locationChannelId: "G0PRIVATE" });
    const result = await executeTool(tool, {
      channel_id: "G0PRIVATE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      channel_id: "G0PRIVATE",
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
      locationChannelId: "D0DM",
      destinationChannelId: "G0PRIVATE",
    });
    const result = await executeTool(tool, {
      channel_id: "G0PRIVATE",
      ts: "1700000000.100000",
    });

    expect(result).toMatchObject({
      channel_id: "G0PRIVATE",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("blocks reading a private group channel from a DM conversation without assistant context", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "G0PRIVATE",
        isPrivate: true,
        isGroup: true,
      }),
    });
    const tool = createTool({ locationChannelId: "D0DM" });
    await expect(
      executeTool(tool, {
        channel_id: "G0PRIVATE",
        ts: "1700000000.100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a private channel that is not the current channel", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "G0OTHER",
        isPrivate: true,
        isGroup: true,
      }),
    });
    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/G0OTHER/p1700000000100000",
      }),
    ).rejects.toThrow("private");

    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("blocks reading a DM channel that is not the current channel", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "D0SOMEONE",
        isIm: true,
      }),
    });
    const tool = createTool();
    await expect(
      executeTool(tool, {
        channel_id: "D0SOMEONE",
        ts: "1700000000.100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("allows reading a public channel proven by conversations.info", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0UNCONFIRMED",
        isPrivate: false,
      }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "public channel root",
          },
        ],
      }),
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C0UNCONFIRMED/p1700000000100000",
    });

    expect(result).toMatchObject({
      channel_id: "C0UNCONFIRMED",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("blocks reading a private channel reported by conversations.info", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0UNCONFIRMED",
        isPrivate: true,
      }),
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/C0UNCONFIRMED/p1700000000100000",
      }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("does not trust stale persisted public visibility when live Slack proof fails", async () => {
    await getConversationStore().recordActivity({
      conversationId: "slack:C0STALE:1700000000.100000",
      channelName: "was-public",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C0STALE",
      },
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
      source: "slack",
      visibility: "public",
    });
    queueSlackApiError("conversations.info", {
      error: "channel_not_found",
    });

    const tool = createTool({ locationChannelId: "C0CURRENT" });
    await expect(
      executeTool(tool, {
        url: "https://sentry.slack.com/archives/C0STALE/p1700000000100000",
      }),
    ).rejects.toThrow(/not found|cannot see it/i);
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(0);
  });

  it("joins then retries when conversations.replies returns not_in_channel", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0FLAKY" }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        threadTs: "1700000000.100000",
        messages: [
          {
            ts: "1700000000.100000",
            thread_ts: "1700000000.100000",
            user: "U1",
            text: "after join",
          },
        ],
      }),
    });

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0FLAKY",
      ts: "1700000000.100000",
    });
    expect(result).toMatchObject({
      channel_id: "C0FLAKY",
      joined_channel: true,
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.join")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(2);
  });

  it("returns a recoverable error when replies still fail after join", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0STILL" }),
    });
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });

    const tool = createTool({});
    await expect(
      executeTool(tool, {
        channel_id: "C0STILL",
        ts: "1700000000.100000",
      }),
    ).rejects.toThrow("Could not read this Slack thread");
  });

  it("returns an error for invalid URL input", async () => {
    const tool = createTool();
    await expect(executeTool(tool, { url: "not a valid url" })).rejects.toThrow(
      "Input is not a valid URL",
    );
  });

  it("returns an error when neither url nor channel_id+ts are provided", async () => {
    const tool = createTool();
    await expect(executeTool(tool, {})).rejects.toThrow("Provide either");
  });

  it("rejects invalid explicit ts format", async () => {
    const tool = createTool();
    await expect(
      executeTool(tool, {
        channel_id: "C123",
        ts: "not-a-timestamp",
      }),
    ).rejects.toThrow("Invalid `ts` Slack timestamp");
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

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C0PAGED",
      ts: "1700000000.000000",
    });

    expect(result).toMatchObject({
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

    const tool = createTool({});
    const result = await executeTool(tool, {
      channel_id: "C123",
      ts: "1700000000.100000",
    });

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

    const tool = createTool({});
    await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000100000",
    });

    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });
});
