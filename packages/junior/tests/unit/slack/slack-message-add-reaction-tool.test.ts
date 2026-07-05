import { describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackMessageAddReactionTool } from "@/chat/slack/tools/message-add-reaction";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";

const addReactionToMessage = vi.fn();

vi.mock("@/chat/slack/outbound", () => ({
  addReactionToMessage: (...args: unknown[]) => addReactionToMessage(...args),
}));

const TEST_MESSAGE_TS = parseSlackMessageTs("1700000000.100");
if (!TEST_MESSAGE_TS) {
  throw new Error("Test message timestamp must be a valid Slack ts");
}
const TEST_CHANNEL_ID = parseSlackChannelId("C123");
if (!TEST_CHANNEL_ID) {
  throw new Error("Test Slack channel ID must be valid");
}
const TEST_TEAM_ID = parseSlackTeamId("T123");
if (!TEST_TEAM_ID) {
  throw new Error("Test Slack team ID must be valid");
}

const TEST_SLACK_CONTEXT: SlackToolContext = {
  destination: {
    platform: "slack",
    teamId: TEST_TEAM_ID,
    channelId: TEST_CHANNEL_ID,
  },
  source: createSlackSource({
    teamId: TEST_TEAM_ID,
    channelId: TEST_CHANNEL_ID,
    messageTs: TEST_MESSAGE_TS,

    type: "priv",
  }),
  destinationChannelId: TEST_CHANNEL_ID,
  messageTs: TEST_MESSAGE_TS,
  sourceChannelId: TEST_CHANNEL_ID,
  teamId: TEST_TEAM_ID,
};

function createState() {
  const cache = new Map<string, unknown>();
  return {
    getOperationResult: <T>(key: string): T | undefined =>
      cache.get(key) as T | undefined,
    setOperationResult: (key: string, value: unknown): void => {
      cache.set(key, value);
    },
  };
}

describe("addReaction tool", () => {
  it("rejects non-alias emoji input", async () => {
    addReactionToMessage.mockReset();
    const tool = createSlackMessageAddReactionTool(
      TEST_SLACK_CONTEXT,
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    await expect(tool.execute({ emoji: "✅" }, {} as any)).rejects.toThrow(
      ToolInputError,
    );
    expect(addReactionToMessage).not.toHaveBeenCalled();
  });

  it("normalizes valid alias emoji names", async () => {
    addReactionToMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    const tool = createSlackMessageAddReactionTool(
      TEST_SLACK_CONTEXT,
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    const result = await tool.execute({ emoji: ":Thumbs_Up:" }, {} as any);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        emoji: "thumbs_up",
      }),
    );
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "thumbs_up",
      }),
    );
  });

  it("preserves documented Slack skin-tone modifiers", async () => {
    addReactionToMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    const tool = createSlackMessageAddReactionTool(
      TEST_SLACK_CONTEXT,
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    const result = await tool.execute(
      { emoji: ":thumbsup::skin-tone-6:" },
      {} as any,
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        emoji: "thumbsup::skin-tone-6",
      }),
    );
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "thumbsup::skin-tone-6",
      }),
    );
  });
});
