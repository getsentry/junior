import { describe, expect, it } from "vitest";
import { createSlackThreadReadTool } from "@/chat/tools/slack/thread-read";
import { conversationsRepliesPage } from "../fixtures/slack/factories/api";
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

describe("slackThreadRead", () => {
  it("reads a thread from a plain Slack archive URL", async () => {
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

    const tool = createSlackThreadReadTool();
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

    const calls = getCapturedSlackApiCalls("conversations.replies");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      channel: "C0AHB7N2JCR",
      ts: "1700000000.123456",
    });
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

    const tool = createSlackThreadReadTool();
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

    const calls = getCapturedSlackApiCalls("conversations.replies");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
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

    const tool = createSlackThreadReadTool();
    const result = await executeTool(tool, {
      channel_id: "C_MANUAL",
      ts: "1700000000.500000",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C_MANUAL",
      target_message_ts: "1700000000.500000",
      count: 1,
    });
    expect(result.messages[0].text).toBe("standalone message");

    const calls = getCapturedSlackApiCalls("conversations.replies");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      channel: "C_MANUAL",
      ts: "1700000000.500000",
    });
  });

  it("returns a recoverable error when the bot is not in the channel", async () => {
    queueSlackApiError("conversations.replies", {
      error: "not_in_channel",
    });

    const tool = createSlackThreadReadTool();
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C_PRIVATE/p1700000000100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "C_PRIVATE",
      target_message_ts: "1700000000.100000",
      slack_error: "not_in_channel",
    });
    expect(result.error).toContain("Could not read this Slack thread");
  });

  it("returns a recoverable error when the channel is not found", async () => {
    queueSlackApiError("conversations.replies", {
      error: "channel_not_found",
    });

    const tool = createSlackThreadReadTool();
    const result = await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C_GONE/p1700000000100000",
    });

    expect(result).toMatchObject({
      ok: false,
      channel_id: "C_GONE",
      slack_error: "channel_not_found",
    });
  });

  it("returns an error for invalid URL input", async () => {
    const tool = createSlackThreadReadTool();
    const result = await executeTool(tool, {
      url: "not a valid url",
    });

    expect(result).toEqual({
      ok: false,
      error: "Input is not a valid URL",
    });
  });

  it("returns an error when neither url nor channel_id+ts are provided", async () => {
    const tool = createSlackThreadReadTool();
    const result = await executeTool(tool, {});

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Provide either"),
    });
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

    const tool = createSlackThreadReadTool();
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

    const tool = createSlackThreadReadTool();
    await executeTool(tool, {
      url: "https://sentry.slack.com/archives/C123/p1700000000100000",
    });

    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });
});
