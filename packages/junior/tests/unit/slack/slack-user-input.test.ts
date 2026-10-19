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
  updateSlackMessage: vi.fn(),
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

const OPTIONS = { toolCallId: "toolu_1" } as any;

describe("requestUserInput in Slack", () => {
  it("posts a one-click request with a button per choice into the thread once", async () => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue({ ts: "1700000000.200" });
    const execute = slackTool();
    const input = {
      question: "The merge has a conflict in `config.ts`. Use my fix?",
      fields: [
        {
          id: "decision",
          kind: "choice" as const,
          label: "Decision",
          options: [
            { label: "Accept", description: "Push my fix to the branch." },
            { label: "Decline" },
          ],
        },
      ],
    };

    await expect(execute(input, OPTIONS)).resolves.toEqual({
      channel_id: "C123",
      message_ts: "1700000000.200",
      request_id: "toolu_1",
      status: "waiting_for_answer",
    });
    await expect(execute(input, OPTIONS)).resolves.toMatchObject({
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
              action_id: "junior_user_input:choice:0",
              text: { type: "plain_text", text: "Accept", emoji: true },
              value: "Accept",
            },
            {
              type: "button",
              action_id: "junior_user_input:choice:1",
              text: { type: "plain_text", text: "Decline", emoji: true },
              value: "Decline",
            },
            {
              type: "button",
              action_id: "junior_user_input:open",
              text: { type: "plain_text", text: "Other…", emoji: true },
            },
          ],
        },
      ],
    });
  });

  it("posts an Answer button that opens a form for other requests", async () => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue({ ts: "1700000000.300" });
    const execute = slackTool();

    await execute(
      {
        question: "How should I fix it?",
        fields: [
          {
            id: "checks",
            kind: "multi_choice",
            label: "Checks",
            options: [{ label: "Lint" }, { label: "Tests" }],
          },
          { id: "notes", kind: "text", label: "Notes" },
        ],
      },
      OPTIONS,
    );

    const posted = postSlackMessage.mock.calls[0]?.[0] as {
      blocks: unknown[];
      text: string;
    };
    expect(posted.text).toBe(
      "How should I fix it?\n\n- **Checks** (pick any: Lint, Tests)\n- **Notes** (short answer)",
    );
    expect(posted.blocks[1]).toEqual({
      type: "actions",
      block_id: "junior_user_input",
      elements: [
        {
          type: "button",
          action_id: "junior_user_input:open",
          style: "primary",
          text: { type: "plain_text", text: "Answer", emoji: true },
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
          fields: [
            {
              id: "pick",
              kind: "choice",
              label: "Pick",
              options: [{ label: "Yes" }, { label: "yes" }],
            },
          ],
        },
        OPTIONS,
      ),
    ).rejects.toThrow(ToolInputError);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});
