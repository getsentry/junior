import { afterEach, describe, expect, it, vi } from "vitest";

const captureFeedback = vi.hoisted(() => vi.fn(() => "feedback-id"));

vi.mock("@/chat/sentry", () => ({ captureFeedback }));

import { createSubmitFeedbackTool } from "@/chat/tools/submit-feedback";

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
  it("sends the message as Sentry feedback for its Conversation", async () => {
    const tool = createTool();
    const result = await tool.execute!(
      tool.prepareArguments!({
        message: "bash timed out twice after 300s while pnpm install ran.",
      }),
      {},
    );

    expect(result).toEqual({ feedback_id: "feedback-id" });
    expect(captureFeedback).toHaveBeenCalledWith({
      message: "bash timed out twice after 300s while pnpm install ran.",
      name: "Junior agent",
      source: "junior_agent",
      tags: {
        "app.conversation.privacy": "private",
        "gen_ai.conversation.id": "conversation-1",
      },
      url: undefined,
    });
  });

  it("rejects a placeholder message", async () => {
    const tool = createTool();
    await expect(
      tool.execute!(tool.prepareArguments!({ message: "N/A" }), {}),
    ).rejects.toMatchObject({ name: "ToolInputError" });
    expect(captureFeedback).not.toHaveBeenCalled();
  });
});
