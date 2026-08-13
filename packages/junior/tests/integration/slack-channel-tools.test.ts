import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackChannelJoinTool } from "@/chat/slack/tools/channel-join";
import { createSlackChannelListMessagesTool } from "@/chat/slack/tools/channel-list-messages";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { createSendFilesTool } from "@/chat/slack/tools/send-files";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { readSandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ToolState } from "@/chat/tools/types";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import {
  conversationsHistoryPage,
  conversationsInfoOk,
  conversationsJoinOk,
  conversationsListPage,
  reactionsAddOk,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();

  return {
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

      visibility: "private",
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
      stdout: "text/plain\n",
      stderr: "",
    }),
    writeFiles: async () => undefined,
  };
}

function createMaterializeFile(files: Record<string, Buffer> = {}) {
  const sandbox = createSandbox(files);
  return (input: { path: string; filename?: string; mimeType?: string }) =>
    readSandboxFileUpload(sandbox, input);
}

async function executeTool<TInput>(
  tool: any,
  input: TInput,
  options: { toolCallId?: string } = {},
) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, options as any);
}

describe("slack channel tools", () => {
  it("uses source coordinates for sendFiles and destination context for channel reads", async () => {
    const context = createContext("share this in the current channel", {
      sourceChannelId: "D123",
      destinationChannelId: "C0SHARED",
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.113", text: "shared", user: "U1" }],
      }),
    });

    await executeTool(
      createSendFilesTool(
        context,
        createToolState(),
        createMaterializeFile({
          "/tmp/shared.txt": Buffer.from("shared update"),
        }),
      ),
      { files: [{ path: "/tmp/shared.txt" }] },
    );
    await executeTool(createSlackChannelListMessagesTool(context), {
      limit: 10,
    });

    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal")[0]?.params,
    ).toMatchObject({
      channel_id: "D123",
      thread_ts: "1700000000.321",
    });
    expect(
      getCapturedSlackApiCalls("conversations.history")[0]?.params,
    ).toMatchObject({
      channel: "C0SHARED",
    });
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

    expect(result).toMatchObject({
      channel_id: "C123",
      count: 1,
    });
    expect(result).not.toHaveProperty("next_cursor");
    expect(result.messages).toMatchObject([
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

    expect(result).toMatchObject({
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

  it("normalizes numeric channel history timestamps before calling Slack", async () => {
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.300000", text: "hello", user: "U1" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    const result = await executeTool(tool, {
      oldest: 1690000000.123456,
      latest: 1710000000.654321,
    });

    expect(result).toMatchObject({
      channel_id: "C123",
      count: 1,
    });
    expect(
      getCapturedSlackApiCalls("conversations.history")[0]?.params,
    ).toMatchObject({
      channel: "C123",
      oldest: "1690000000.123456",
      latest: "1710000000.654321",
    });
  });

  it("rejects invalid channel history timestamps before calling Slack", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    await expect(
      executeTool(tool, { latest: "slack:C123:not-a-timestamp" }),
    ).rejects.toThrow("Invalid `latest` Slack timestamp");
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
  });

  it("rejects blank channel history timestamps before calling Slack", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    await expect(executeTool(tool, { oldest: "   " })).rejects.toThrow(
      "Invalid `oldest` Slack timestamp",
    );
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
  });

  it("rejects channel history timestamp references for other channels", async () => {
    const tool = createSlackChannelListMessagesTool(
      createContext("list channel messages"),
    );

    await expect(
      executeTool(tool, {
        oldest: "slack:C0OTHER:1710000000.000000",
      }),
    ).rejects.toThrow("Invalid `oldest` Slack timestamp");
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
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
      channel_id: "C123",
      count: 2,
    });
    expect(result).not.toHaveProperty("next_cursor");
    expect(result.messages).toMatchObject([
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

    await expect(
      executeTool(tool, { cursor: "expired-cursor", limit: 10 }),
    ).rejects.toThrow("supplied Slack history cursor is no longer valid");

    const historyCalls = getCapturedSlackApiCalls("conversations.history");
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]?.params).toMatchObject({
      channel: "C123",
      cursor: "expired-cursor",
    });
  });

  it("lists history for another public channel when channel_id is provided", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0OTHER",
        isPrivate: false,
      }),
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.700", text: "other-channel", user: "U3" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list other channel", {
        sourceChannelId: "C123",
      }),
    );

    const result = await executeTool(tool, {
      channel_id: "C0OTHER",
      limit: 5,
    });

    expect(result).toMatchObject({
      channel_id: "C0OTHER",
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.info")).toHaveLength(1);
    expect(
      getCapturedSlackApiCalls("conversations.history")[0]?.params,
    ).toMatchObject({
      channel: "C0OTHER",
    });
  });

  it("blocks history for a private channel_id outside the current conversation", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0PRIVATE",
        isPrivate: true,
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list private channel"),
    );

    await expect(
      executeTool(tool, { channel_id: "C0PRIVATE" }),
    ).rejects.toThrow("private");
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(0);
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
      emoji: "thumbsup",
    });
    expect(second).toMatchObject({
      emoji: "thumbsup",
      deduplicated: true,
    });
    expect(getCapturedSlackApiCalls("reactions.add")).toHaveLength(1);
  });

  it("lists history when channel_id is a public channel name", async () => {
    queueSlackApiResponse("conversations.list", {
      body: conversationsListPage({
        channels: [
          {
            id: "C0PROJ",
            name: "proj-foo",
            is_member: true,
            is_private: false,
          },
        ],
      }),
    });
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0PROJ",
        name: "proj-foo",
        isPrivate: false,
        isMember: true,
      }),
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.710", text: "named-id", user: "U3" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("list by name in channel_id"),
    );
    const result = await executeTool(tool, {
      channel_id: "#proj-foo",
      limit: 5,
    });
    expect(result).toMatchObject({
      channel_id: "C0PROJ",
      channel_name: "proj-foo",
      count: 1,
    });
  });

  it("joins a public channel on demand", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0JOIN",
        name: "announce",
        isPrivate: false,
        isMember: false,
      }),
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0JOIN", name: "announce" }),
    });
    const tool = createSlackChannelJoinTool(createContext("join channel"));
    const result = await executeTool(tool, { channel_id: "C0JOIN" });
    expect(result).toMatchObject({
      channel_id: "C0JOIN",
      channel_name: "announce",
      joined: true,
      already_member: false,
    });
    expect(getCapturedSlackApiCalls("conversations.join")).toHaveLength(1);
  });

  it("joins a public channel when channel_id is a channel name", async () => {
    queueSlackApiResponse("conversations.list", {
      body: conversationsListPage({
        channels: [
          {
            id: "C0JOINNAME",
            name: "join-me",
            is_member: false,
            is_private: false,
          },
        ],
      }),
    });
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0JOINNAME",
        name: "join-me",
        isPrivate: false,
        isMember: false,
      }),
    });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0JOINNAME", name: "join-me" }),
    });
    const tool = createSlackChannelJoinTool(createContext("join by name"));
    const result = await executeTool(tool, { channel_id: "#join-me" });
    expect(result).toMatchObject({
      channel_id: "C0JOINNAME",
      channel_name: "join-me",
      joined: true,
    });
  });

  it("joins then retries channel history when not in channel", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({
        channelId: "C0JOINME",
        name: "joinme",
        isPrivate: false,
        isMember: false,
      }),
    });
    queueSlackApiError("conversations.history", { error: "not_in_channel" });
    queueSlackApiResponse("conversations.join", {
      body: conversationsJoinOk({ channelId: "C0JOINME", name: "joinme" }),
    });
    queueSlackApiResponse("conversations.history", {
      body: conversationsHistoryPage({
        messages: [{ ts: "1700000000.900", text: "after-join", user: "U4" }],
      }),
    });
    const tool = createSlackChannelListMessagesTool(
      createContext("history after join"),
    );
    const result = await executeTool(tool, {
      channel_id: "C0JOINME",
      limit: 5,
    });
    expect(result).toMatchObject({
      channel_id: "C0JOINME",
      joined_channel: true,
      count: 1,
    });
    expect(getCapturedSlackApiCalls("conversations.join")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.history")).toHaveLength(2);
  });
});
