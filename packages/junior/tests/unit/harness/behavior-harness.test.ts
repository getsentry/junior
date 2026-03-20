import { afterEach, describe, expect, it, vi } from "vitest";

const { observedRuntimeIds, handleNewMentionMock, noopAsync } = vi.hoisted(
  () => ({
    observedRuntimeIds: {
      messageThreadId: undefined as string | undefined,
      threadId: undefined as string | undefined,
    },
    handleNewMentionMock: vi.fn(
      async (
        thread: { id: string; post: (value: string) => Promise<void> },
        message: { threadId?: string },
      ) => {
        observedRuntimeIds.threadId = thread.id;
        observedRuntimeIds.messageThreadId = message.threadId;
        await thread.post("observed");
      },
    ),
    noopAsync: vi.fn(async () => {}),
  }),
);

vi.mock("@/chat/bot", () => ({
  appSlackRuntime: {
    handleNewMention: handleNewMentionMock,
    handleSubscribedMessage: noopAsync,
    handleAssistantThreadStarted: noopAsync,
    handleAssistantContextChanged: noopAsync,
  },
  bot: {
    getAdapter: () => undefined,
  },
  resetBotDepsForTests: noopAsync,
  setBotDepsForTests: noopAsync,
}));

import { runBehaviorEvalCase } from "../../../evals/behavior-harness";

describe("behavior harness", () => {
  afterEach(() => {
    observedRuntimeIds.threadId = undefined;
    observedRuntimeIds.messageThreadId = undefined;
    handleNewMentionMock.mockClear();
    noopAsync.mockClear();
  });

  it("normalizes eval thread fixtures to Slack-style runtime thread ids", async () => {
    const result = await runBehaviorEvalCase({
      events: [
        {
          type: "new_mention",
          thread: {
            id: "fixture-auth-thread",
            channel_id: "C_AUTH",
            thread_ts: "1700000000.0001",
          },
          message: {
            id: "m-auth-1",
            text: "hello",
            is_mention: true,
            author: {
              user_id: "U_AUTH",
            },
          },
        },
      ],
    });

    expect(handleNewMentionMock).toHaveBeenCalledTimes(1);
    expect(observedRuntimeIds.threadId).toBe("slack:C_AUTH:1700000000.0001");
    expect(observedRuntimeIds.messageThreadId).toBe(
      "slack:C_AUTH:1700000000.0001",
    );
    expect(result.posts).toEqual(["observed"]);
  });
});
