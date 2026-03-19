import { describe, expect, it } from "vitest";
import { createSlackChannelListMessagesTool } from "@/chat/tools/slack-channel-list-messages";
import { createSlackChannelPostMessageTool } from "@/chat/tools/slack-channel-post-message";
import { createSlackMessageAddReactionTool } from "@/chat/tools/slack-message-add-reaction";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";
import {
  chatGetPermalinkOk,
  chatPostMessageOk,
  conversationsHistoryPage,
  reactionsAddOk,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {
    listColumnMap: {},
  };
  let turnCreatedCanvasId: string | undefined;

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: () => undefined,
    getCurrentCanvasId: () => undefined,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => undefined,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

function createContext(userText: string): ToolRuntimeContext {
  return {
    channelId: "C123",
    messageTs: "1700000000.321",
    userText,
    sandbox: {} as any,
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slack channel tools", () => {
  it("posts to channel even without explicit post-intent phrasing in user text", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        ts: "1700000000.111",
        channel: "C123",
      }),
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink: "https://example.invalid/permalink-1",
      }),
    });
    const tool = createSlackChannelPostMessageTool(
      createContext("summarize this thread"),
      createToolState(),
    );
    const result = await executeTool(tool, {
      text: "Posting this update",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      ts: "1700000000.111",
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
  });

  it("posts to channel when explicit post intent is present and deduplicates within turn", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        ts: "1700000000.200",
        channel: "C123",
      }),
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink: "https://example.invalid/permalink",
      }),
    });
    const tool = createSlackChannelPostMessageTool(
      createContext("please post this in #eng channel"),
      createToolState(),
    );

    const first = await executeTool(tool, {
      text: "Incident resolved.",
    });
    const second = await executeTool(tool, {
      text: "Incident resolved.",
    });

    expect(first).toMatchObject({
      ok: true,
      channel_id: "C123",
      ts: "1700000000.200",
    });
    expect(second).toMatchObject({
      ok: true,
      deduplicated: true,
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.params).toMatchObject({
      channel: "C123",
      text: "Incident resolved.",
    });
    expect(postCalls[0]?.params).toHaveProperty("mrkdwn");
    expect(getCapturedSlackApiCalls("chat.getPermalink")).toHaveLength(1);
  });

  it("lists channel messages across history parameters and forwards filters", async () => {
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.300", text: "hello", user: "U1" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      limit: 150,
      oldest: "1690000000.000",
      latest: "1710000000.000",
      max_pages: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 1,
      next_cursor: undefined,
    });
    expect(result).toMatchObject({
      messages: [{ ts: "1700000000.300", text: "hello", user: "U1" }],
    });

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]?.params).toMatchObject({
      channel: "C123",
      oldest: "1690000000.000",
      latest: "1710000000.000",
    });
    expect(String(historyCalls[0]?.params.limit)).toBe("150");
  });

  it("returns posted message even when permalink lookup fails", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        ts: "1700000000.400",
        channel: "C123",
      }),
    });
    queueSlackApiError("chat.getPermalink", {
      error: "not_in_channel",
    });
    const tool = createSlackChannelPostMessageTool(
      createContext("please post this in #eng channel"),
      createToolState(),
    );

    const result = await executeTool(tool, {
      text: "Heads-up update",
    });

    expect(result).toEqual({
      ok: true,
      channel_id: "C123",
      ts: "1700000000.400",
      permalink: undefined,
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.getPermalink")).toHaveLength(1);
  });

  it("traverses conversation history pagination up to the requested limit", async () => {
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.500", text: "page-1", user: "U1" }],
        nextCursor: "cursor-next",
      }),
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.501", text: "page-2", user: "U2" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      limit: 2,
      max_pages: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 2,
      next_cursor: undefined,
    });
    expect(result).toMatchObject({
      messages: [
        { ts: "1700000000.500", text: "page-1", user: "U1" },
        { ts: "1700000000.501", text: "page-2", user: "U2" },
      ],
    });

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(2);
    expect(String(historyCalls[0]?.params.limit)).toBe("2");
    expect(historyCalls[1]?.params).toMatchObject({
      channel: "C123",
      cursor: "cursor-next",
    });
    expect(String(historyCalls[1]?.params.limit)).toBe("1");
  });

  it("adds a reaction to the implicitly targeted inbound message", async () => {
    queueSlackApiResponse("reactions.add", {
      body: reactionsAddOk(),
    });
    const tool = createSlackMessageAddReactionTool(
      createContext("yep"),
      createToolState(),
    );

    const result = await executeTool(tool, {
      emoji: ":wave:",
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      message_ts: "1700000000.321",
      emoji: "wave",
    });
    const reactionCalls = getCapturedSlackApiCalls("reactions.add");
    expect(reactionCalls).toHaveLength(1);
    expect(reactionCalls[0]?.params).toMatchObject({
      channel: "C123",
      timestamp: "1700000000.321",
      name: "wave",
    });
  });

  it("passes Slack skin-tone aliases through to reactions.add", async () => {
    queueSlackApiResponse("reactions.add", {
      body: reactionsAddOk(),
    });
    const tool = createSlackMessageAddReactionTool(
      createContext("yep"),
      createToolState(),
    );

    const result = await executeTool(tool, {
      emoji: ":thumbsup::skin-tone-6:",
    });

    expect(result).toMatchObject({
      ok: true,
      emoji: "thumbsup::skin-tone-6",
    });
    const reactionCalls = getCapturedSlackApiCalls("reactions.add");
    expect(reactionCalls).toHaveLength(1);
    expect(reactionCalls[0]?.params).toMatchObject({
      name: "thumbsup::skin-tone-6",
    });
  });

  it("deduplicates repeated reactions to the same message in one turn", async () => {
    queueSlackApiResponse("reactions.add", {
      body: reactionsAddOk(),
    });
    const tool = createSlackMessageAddReactionTool(
      createContext("ack"),
      createToolState(),
    );

    const first = await executeTool(tool, {
      emoji: "thumbsup",
    });
    const second = await executeTool(tool, {
      emoji: "thumbsup",
    });

    expect(first).toMatchObject({
      ok: true,
      emoji: "thumbsup",
    });
    expect(second).toMatchObject({
      ok: true,
      emoji: "thumbsup",
      deduplicated: true,
    });
    expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
  });
});
