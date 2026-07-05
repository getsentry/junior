import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSendMessageTool } from "@/chat/slack/tools/send-message";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { readSandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ToolState } from "@/chat/tools/types";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
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

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: () => undefined,
    getCurrentListId: () => undefined,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

type ContextOverrides = Omit<
  Partial<SlackToolContext>,
  | "destinationChannelId"
  | "messageTs"
  | "sourceChannelId"
  | "teamId"
  | "threadTs"
> & {
  destinationChannelId?: string;
  messageTs?: string;
  sourceChannelId?: string;
  teamId?: string;
  threadTs?: string;
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

function requireSlackMessageTs(value: string) {
  const timestamp = parseSlackMessageTs(value);
  if (!timestamp) {
    throw new Error(`Invalid test Slack timestamp: ${value}`);
  }
  return timestamp;
}

function createContext(
  _userText: string,
  overrides: ContextOverrides = {},
): SlackToolContext {
  const sourceChannelId = requireSlackChannelId(
    overrides.sourceChannelId ?? "C123",
  );
  const destinationChannelId =
    overrides.destinationChannelId !== undefined
      ? requireSlackChannelId(overrides.destinationChannelId)
      : sourceChannelId;
  const teamId = requireSlackTeamId(overrides.teamId ?? "T123");
  const {
    sourceChannelId: _sourceChannelId,
    destinationChannelId: _destinationChannelId,
    messageTs: overrideMessageTs,
    teamId: _teamId,
    threadTs: overrideThreadTs,
    ...rest
  } = overrides;
  const messageTs = requireSlackMessageTs(
    overrideMessageTs ?? "1700000000.321",
  );
  const threadTs = overrideThreadTs
    ? requireSlackMessageTs(overrideThreadTs)
    : undefined;
  return {
    destination: {
      platform: "slack",
      teamId,
      channelId: destinationChannelId,
    },
    source: createSlackSource({
      teamId,
      channelId: sourceChannelId,
      messageTs,

      type: "priv",
    }),
    destinationChannelId,
    messageTs,
    sourceChannelId,
    teamId,
    ...(threadTs ? { threadTs } : {}),
    ...rest,
  };
}

function createSandbox(files: Record<string, Buffer> = {}): SandboxWorkspace {
  return {
    readFileToBuffer: async ({ path }) => files[path] ?? null,
    runCommand: async () => ({
      exitCode: 0,
      stdout: async () => "text/plain\n",
      stderr: async () => "",
    }),
  };
}

function createMaterializeFile(files: Record<string, Buffer> = {}) {
  const sandbox = createSandbox(files);
  return (input: { path: string; filename?: string; mimeType?: string }) =>
    readSandboxFileUpload(sandbox, input);
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
    const tool = createSendMessageTool(
      createContext("summarize this thread"),
      createToolState(),
      createMaterializeFile(),
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

  it("uses assistant context channel for channel delivery tools in DM turns", async () => {
    const context = createContext("share this in the current channel", {
      sourceChannelId: "D123",
      destinationChannelId: "C0SHARED",
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        ts: "1700000000.112",
        channel: "C0SHARED",
      }),
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink: "https://example.invalid/permalink-shared",
      }),
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.113", text: "shared", user: "U1" }],
      }),
    });

    await executeTool(
      createSendMessageTool(
        context,
        createToolState(),
        createMaterializeFile(),
      ),
      { text: "Shared update" },
    );
    await executeTool(createSlackChannelListMessagesTool(context), {
      limit: 10,
    });

    expect(
      getCapturedSlackApiCalls("chat.postMessage")[0]?.params,
    ).toMatchObject({
      channel: "C0SHARED",
      text: "Shared update",
    });
    expect(
      getCapturedSlackApiCalls("conversations.history")[0]?.params,
    ).toMatchObject({
      channel: "C0SHARED",
    });
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
    const tool = createSendMessageTool(
      createContext("please post this in #eng channel"),
      createToolState(),
      createMaterializeFile(),
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
      latest: "1710000000",
      max_pages: 3,
    });

    expect(result.details).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 1,
    });
    expect(result.details).not.toHaveProperty("next_cursor");
    const body = JSON.parse(result.content[0].text);
    expect(body.messages).toMatchObject([
      { ts: "1700000000.300", text: "hello", user: "U1" },
    ]);

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]?.params).toMatchObject({
      channel: "C123",
      oldest: "1690000000.000",
      latest: "1710000000",
    });
    expect(String(historyCalls[0]?.params.limit)).toBe("150");
  });

  it("normalizes Slack thread references before listing channel messages", async () => {
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.300000", text: "hello", user: "U1" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      oldest: "slack:C123:1690000000.000000",
      latest: " slack:C123:1710000000.000000 ",
    });

    expect(result.details).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 1,
    });
    expect(
      getCapturedSlackApiCalls("conversations.history")[0]?.params,
    ).toMatchObject({
      channel: "C123",
      oldest: "1690000000.000000",
      latest: "1710000000.000000",
    });
  });

  it("rejects invalid channel history timestamps before calling Slack", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      latest: "slack:C123:not-a-timestamp",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Invalid `latest` Slack timestamp. Use a numeric Slack ts like `1712345678.123456`.",
    });
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
  });

  it("rejects blank channel history timestamps before calling Slack", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      oldest: "   ",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Invalid `oldest` Slack timestamp. Use a numeric Slack ts like `1712345678.123456`.",
    });
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
  });

  it("rejects channel history timestamp references for other channels", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      oldest: "slack:C0OTHER:1710000000.000000",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Invalid `oldest` Slack timestamp. Use a numeric Slack ts like `1712345678.123456`.",
    });
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
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
    const tool = createSendMessageTool(
      createContext("please post this in #eng channel"),
      createToolState(),
      createMaterializeFile(),
    );

    const result = await executeTool(tool, {
      text: "Heads-up update",
    });

    expect(result).toEqual({
      ok: true,
      target: "channel",
      channel_id: "C123",
      ts: "1700000000.400",
      permalink: undefined,
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.getPermalink")).toHaveLength(1);
  });

  it("sends text with files through Slack file upload", async () => {
    const tool = createSendMessageTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      target: "channel",
      text: "Here is the report.",
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      file_count: 1,
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      initial_comment: "Here is the report.",
    });
  });

  it("sends file-only messages without posting empty text", async () => {
    const tool = createSendMessageTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      target: "channel",
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      file_count: 1,
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).not.toHaveProperty("initial_comment");
  });

  it("sends text messages into the current Slack thread", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        ts: "1700000000.700",
        channel: "C123",
      }),
    });
    queueSlackApiResponse("chat.getPermalink", {
      body: chatGetPermalinkOk({
        permalink: "https://example.invalid/thread-message",
      }),
    });
    const tool = createSendMessageTool(
      createContext("reply in thread", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile(),
    );

    const result = await executeTool(tool, {
      target: "thread",
      text: "Thread update.",
    });

    expect(result).toMatchObject({
      ok: true,
      target: "thread",
      channel_id: "C123",
      thread_ts: "1700000000.321",
      ts: "1700000000.700",
    });
    expect(
      getCapturedSlackApiCalls("chat.postMessage")[0]?.params,
    ).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.321",
      text: "Thread update.",
    });
  });

  it("uses source thread coordinates for thread delivery in assistant-context turns", async () => {
    const context = createContext("attach this here", {
      sourceChannelId: "D123",
      destinationChannelId: "CSHARED",
      threadTs: "1700000000.321",
    });
    const tool = createSendMessageTool(
      context,
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      target: "thread",
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toMatchObject({
      ok: true,
      target: "thread",
      channel_id: "D123",
      thread_ts: "1700000000.321",
      file_count: 1,
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "D123",
      thread_ts: "1700000000.321",
    });
  });

  it("uploads files into the current Slack thread", async () => {
    const tool = createSendMessageTool(
      createContext("attach the report", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      target: "thread",
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toMatchObject({
      ok: true,
      target: "thread",
      channel_id: "C123",
      thread_ts: "1700000000.321",
      file_count: 1,
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
  });

  it("defaults file uploads to the current Slack thread", async () => {
    const tool = createSendMessageTool(
      createContext("attach the report", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(result).toMatchObject({
      ok: true,
      target: "thread",
      channel_id: "C123",
      thread_ts: "1700000000.321",
      file_count: 1,
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
  });

  it("treats nullable optional sendMessage fields as omitted", async () => {
    const tool = createSendMessageTool(
      createContext("attach the report", {
        threadTs: "1700000000.321",
      }),
      createToolState(),
      createMaterializeFile({
        "/tmp/report.txt": Buffer.from("report body"),
      }),
    );

    const result = await executeTool(tool, {
      target: null,
      text: null,
      files: [{ path: "/tmp/report.txt", filename: null, mimeType: null }],
    });

    expect(result).toMatchObject({
      ok: true,
      target: "thread",
      channel_id: "C123",
      thread_ts: "1700000000.321",
      file_count: 1,
    });
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.321",
    });
  });

  it("rejects invalid sendMessage targets", async () => {
    const tool = createSendMessageTool(
      createContext("send this"),
      createToolState(),
      createMaterializeFile(),
    );

    await expect(
      executeTool(tool, {
        target: "dm",
        text: "Invalid target.",
      }),
    ).rejects.toThrow("sendMessage target must be `channel` or `thread`");
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
  });

  it("does not deduplicate changed file contents at the same path", async () => {
    const files = {
      "/tmp/report.txt": Buffer.from("first report"),
    };
    const tool = createSendMessageTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile(files),
    );

    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });
    files["/tmp/report.txt"] = Buffer.from("updated report");
    await executeTool(tool, {
      files: [{ path: "/tmp/report.txt" }],
    });

    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(2);
  });

  it("requires text or at least one file", async () => {
    const tool = createSendMessageTool(
      createContext("share this file"),
      createToolState(),
      createMaterializeFile(),
    );

    await expect(executeTool(tool, {})).rejects.toThrow(
      "sendMessage requires text or at least one file",
    );
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

    expect(result.details).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 2,
    });
    expect(result.details).not.toHaveProperty("next_cursor");
    const body = JSON.parse(result.content[0].text);
    expect(body.messages).toMatchObject([
      { ts: "1700000000.500", text: "page-1", user: "U1" },
      { ts: "1700000000.501", text: "page-2", user: "U2" },
    ]);

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(2);
    expect(String(historyCalls[0]?.params.limit)).toBe("2");
    expect(historyCalls[1]?.params).toMatchObject({
      channel: "C123",
      cursor: "cursor-next",
    });
    expect(String(historyCalls[1]?.params.limit)).toBe("1");
  });

  it("returns a recoverable tool error when Slack rejects a stale history cursor", async () => {
    queueSlackApiError("conversations.history", {
      error: "invalid_cursor",
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      cursor: "expired-cursor",
      limit: 10,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "The supplied Slack history cursor is no longer valid. Retry the lookup without `cursor` to start from the newest page again.",
    });

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]?.params).toMatchObject({
      channel: "C123",
      cursor: "expired-cursor",
    });
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

  it("treats already_reacted as a safe reaction success", async () => {
    queueSlackApiError("reactions.add", {
      error: "already_reacted",
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
    expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
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
