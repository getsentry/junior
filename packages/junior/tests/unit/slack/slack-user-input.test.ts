import { describe, expect, it, vi } from "vitest";
import { createSlackUserInputShow } from "@/chat/slack/tools/user-input";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { parseSlackChannelId, parseSlackTeamId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createRequestUserInputTool } from "@/chat/tools/runtime/request-user-input";

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

function slackTool() {
  const tool = createRequestUserInputTool(
    createSlackUserInputShow(CONTEXT, createState()),
  );
  if (!tool.execute) throw new Error("Expected executable tool");
  return tool.execute;
}

describe("requestUserInput in Slack", () => {
  it("posts the question with one button per choice into the thread once", async () => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue({ ts: "1700000000.200" });
    const execute = slackTool();
    const input = {
      question: "The merge has a conflict in `config.ts`. Use my fix?",
      options: [
        { label: "Accept", description: "Push my fix to the branch." },
        { label: "Decline" },
      ],
    };

    await expect(execute(input, {} as any)).resolves.toEqual({
      channel_id: "C123",
      message_ts: "1700000000.200",
      status: "waiting_for_answer",
    });
    await expect(execute(input, {} as any)).resolves.toMatchObject({
      deduplicated: true,
    });

    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const text =
      "The merge has a conflict in `config.ts`. Use my fix?\n\n- **Accept**: Push my fix to the branch.";
    expect(postSlackMessage).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: "1700000000.100",
      text,
      blocks: [
        { type: "markdown", text },
        {
          type: "actions",
          block_id: "junior_user_input",
          elements: [
            {
              type: "button",
              action_id: "junior_user_input:0",
              text: { type: "plain_text", text: "Accept", emoji: true },
              value: "Accept",
            },
            {
              type: "button",
              action_id: "junior_user_input:1",
              text: { type: "plain_text", text: "Decline", emoji: true },
              value: "Decline",
            },
          ],
        },
      ],
    });
  });

  it("rejects choices that people cannot tell apart", async () => {
    postSlackMessage.mockReset();
    const execute = slackTool();

    await expect(
      execute(
        {
          question: "Pick one",
          options: [{ label: "Yes" }, { label: "yes" }],
        },
        {} as any,
      ),
    ).rejects.toThrow(ToolInputError);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});
