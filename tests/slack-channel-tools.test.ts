import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackChannelListMembersTool } from "@/chat/tools/slack-channel-list-members";
import { createSlackChannelListMessagesTool } from "@/chat/tools/slack-channel-list-messages";
import { createSlackChannelPostMessageTool } from "@/chat/tools/slack-channel-post-message";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

const postMessageToChannelMock = vi.fn();
const listChannelMembersMock = vi.fn();
const listChannelMessagesMock = vi.fn();

vi.mock("@/chat/slack-actions/channel", () => ({
  postMessageToChannel: (...args: unknown[]) => postMessageToChannelMock(...args),
  listChannelMembers: (...args: unknown[]) => listChannelMembersMock(...args),
  listChannelMessages: (...args: unknown[]) => listChannelMessagesMock(...args)
}));

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {
    listColumnMap: {}
  };

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: () => undefined,
    getCurrentCanvasId: () => undefined,
    getCurrentListId: () => undefined,
    getOperationResult: <T>(operationKey: string): T | undefined => operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    }
  };
}

function createContext(userText: string): ToolRuntimeContext {
  return {
    channelId: "C123",
    userText,
    sandbox: {} as any
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slack channel tools", () => {
  beforeEach(() => {
    postMessageToChannelMock.mockReset();
    listChannelMembersMock.mockReset();
    listChannelMessagesMock.mockReset();
  });

  it("blocks channel posting without explicit post intent in user text", async () => {
    const tool = createSlackChannelPostMessageTool(createContext("summarize this thread"), createToolState());
    const result = await executeTool(tool, {
      text: "Posting this update"
    });

    expect(result).toMatchObject({
      ok: false
    });
    expect(postMessageToChannelMock).not.toHaveBeenCalled();
  });

  it("posts to channel when explicit post intent is present and deduplicates within turn", async () => {
    postMessageToChannelMock.mockResolvedValue({
      ts: "1700000000.200",
      permalink: "https://example.invalid/permalink"
    });
    const tool = createSlackChannelPostMessageTool(
      createContext("please post this in #eng channel"),
      createToolState()
    );

    const first = await executeTool(tool, {
      text: "Incident resolved."
    });
    const second = await executeTool(tool, {
      text: "Incident resolved."
    });

    expect(first).toMatchObject({
      ok: true,
      channel_id: "C123",
      ts: "1700000000.200"
    });
    expect(second).toMatchObject({
      ok: true,
      deduplicated: true
    });
    expect(postMessageToChannelMock).toHaveBeenCalledTimes(1);
  });

  it("lists channel members with rich profile fields", async () => {
    listChannelMembersMock.mockResolvedValue({
      members: [
        {
          user_id: "U1",
          name: "alice",
          email: "alice@example.com",
          title: "Engineer"
        }
      ],
      nextCursor: "next-members"
    });
    const tool = createSlackChannelListMembersTool(createContext("who is in this channel?"));

    const result = await executeTool(tool, {
      limit: 25
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 1,
      next_cursor: "next-members"
    });
    expect(listChannelMembersMock).toHaveBeenCalledWith({
      channelId: "C123",
      limit: 25,
      cursor: undefined
    });
  });

  it("lists channel messages across history parameters", async () => {
    listChannelMessagesMock.mockResolvedValue({
      messages: [{ ts: "1700000000.300", text: "hello", user: "U1" }],
      nextCursor: "next-history"
    });
    const tool = createSlackChannelListMessagesTool(createContext("list channel messages"));

    const result = await executeTool(tool, {
      limit: 150,
      oldest: "1690000000.000",
      latest: "1710000000.000",
      max_pages: 3
    });

    expect(result).toMatchObject({
      ok: true,
      channel_id: "C123",
      count: 1,
      next_cursor: "next-history"
    });
    expect(listChannelMessagesMock).toHaveBeenCalledWith({
      channelId: "C123",
      limit: 150,
      cursor: undefined,
      oldest: "1690000000.000",
      latest: "1710000000.000",
      inclusive: undefined,
      maxPages: 3
    });
  });
});
