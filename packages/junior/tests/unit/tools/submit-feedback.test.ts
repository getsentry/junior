import { afterEach, describe, expect, it, vi } from "vitest";

const captureFeedback = vi.hoisted(() => vi.fn(() => "feedback-id"));

vi.mock("@/chat/sentry", () => ({ captureFeedback }));

import { createSubmitFeedbackTool } from "@/chat/tools/submit-feedback";

const input = {
  task: "Run the repo tests",
  kind: "slow",
  impact: "worked_around",
  description: "bash timed out twice after 300s while pnpm install ran.",
  tool_name: "bash",
};

function createTool() {
  return createSubmitFeedbackTool({
    conversationId: "conversation-1",
    conversationPrivacy: "private",
  });
}

afterEach(() => {
  captureFeedback.mockClear();
});

describe("submitFeedback", () => {
  it("sends one Sentry feedback with the problem and its Conversation", async () => {
    const tool = createTool();
    const result = await tool.execute!(tool.prepareArguments!(input), {});

    expect(result).toEqual({ feedback_id: "feedback-id" });
    expect(captureFeedback).toHaveBeenCalledWith({
      message:
        "Task: Run the repo tests\nTool: bash\n\nbash timed out twice after 300s while pnpm install ran.",
      name: "Junior agent",
      source: "junior_agent",
      tags: {
        "app.conversation.privacy": "private",
        "app.feedback.impact": "worked_around",
        "app.feedback.kind": "slow",
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.tool.name": "bash",
      },
      url: undefined,
    });
  });

  it("treats a null tool name as omitted", async () => {
    const tool = createTool();
    await tool.execute!(
      tool.prepareArguments!({ ...input, tool_name: null }),
      {},
    );

    expect(captureFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Task: Run the repo tests\n\nbash timed out twice after 300s while pnpm install ran.",
        tags: expect.not.objectContaining({
          "gen_ai.tool.name": expect.anything(),
        }),
      }),
    );
  });

  it("rejects a placeholder description", async () => {
    const tool = createTool();
    await expect(
      tool.execute!(
        tool.prepareArguments!({ ...input, description: "N/A" }),
        {},
      ),
    ).rejects.toMatchObject({ name: "ToolInputError" });
    expect(captureFeedback).not.toHaveBeenCalled();
  });

  it("sends at most one feedback from one tool registry", async () => {
    const tool = createTool();
    await tool.execute!(tool.prepareArguments!(input), {});

    await expect(
      tool.execute!(tool.prepareArguments!(input), {}),
    ).rejects.toMatchObject({ name: "ToolInputError" });
    expect(captureFeedback).toHaveBeenCalledTimes(1);
  });
});
