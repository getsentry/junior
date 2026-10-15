import { describe, expect, it, vi } from "vitest";
import { createSlackMessagePostButtonsTool } from "@/chat/slack/tools/message-post-buttons";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const postSlackMessage = vi.fn();

vi.mock("@/chat/slack/outbound", () => ({
  postSlackMessage: (...args: unknown[]) => postSlackMessage(...args),
}));

const CHANNEL_ID = parseSlackChannelId("C123");
const TEAM_ID = parseSlackTeamId("T123");
const THREAD_TS = parseSlackMessageTs("1700000000.100");
if (!CHANNEL_ID || !TEAM_ID || !THREAD_TS) {
  throw new Error("Test Slack ids must be valid");
}

const CONTEXT: SlackToolContext = {
  destinationChannelId: CHANNEL_ID,
  locationChannelId: CHANNEL_ID,
  messageChannelId: CHANNEL_ID,
  messageTs: THREAD_TS,
  teamId: TEAM_ID,
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

describe("slackButtonsPost tool", () => {
  it("posts one row of buttons into the active thread once", async () => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue({ ts: "1700000000.200" });
    const tool = createSlackMessagePostButtonsTool(CONTEXT, createState());
    if (!tool.execute) throw new Error("Expected executable tool");
    const input = {
      text: "Ship this release?",
      buttons: [
        { label: "Ship it", value: "ship 1.2.3", style: "primary" as const },
        { label: "Hold", value: "hold 1.2.3" },
      ],
    };

    await expect(tool.execute(input, {} as any)).resolves.toEqual({
      channel_id: "C123",
      message_ts: "1700000000.200",
    });
    await expect(tool.execute(input, {} as any)).resolves.toMatchObject({
      deduplicated: true,
    });

    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(postSlackMessage).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: "1700000000.100",
      text: "Ship this release?",
      blocks: [
        { type: "markdown", text: "Ship this release?" },
        {
          type: "actions",
          block_id: "junior_buttons",
          elements: [
            {
              type: "button",
              action_id: "junior_button:0",
              text: { type: "plain_text", text: "Ship it", emoji: true },
              value: "ship 1.2.3",
              style: "primary",
            },
            {
              type: "button",
              action_id: "junior_button:1",
              text: { type: "plain_text", text: "Hold", emoji: true },
              value: "hold 1.2.3",
            },
          ],
        },
      ],
    });
  });

  it("rejects buttons that people cannot tell apart", async () => {
    postSlackMessage.mockReset();
    const tool = createSlackMessagePostButtonsTool(CONTEXT, createState());
    if (!tool.execute) throw new Error("Expected executable tool");

    await expect(
      tool.execute(
        {
          text: "Pick one",
          buttons: [
            { label: "Yes", value: "a" },
            { label: "Yes", value: "b" },
          ],
        },
        {} as any,
      ),
    ).rejects.toThrow(ToolInputError);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});
