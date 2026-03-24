import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const {
  observedRuntimeIds,
  originalStateAdapterEnv,
  noopAsync,
  handleNewMentionMock,
} = vi.hoisted(() => {
  const originalStateAdapterEnv = process.env.JUNIOR_STATE_ADAPTER;
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  const observedRuntimeIds = {
    messageThreadId: undefined as string | undefined,
    threadId: undefined as string | undefined,
  };

  return {
    observedRuntimeIds,
    originalStateAdapterEnv,
    noopAsync: vi.fn(async () => {}),
    handleNewMentionMock: vi.fn(
      async (
        thread: { id: string; post: (value: unknown) => Promise<void> },
        message: { threadId?: string },
      ) => {
        observedRuntimeIds.threadId = thread.id;
        observedRuntimeIds.messageThreadId = message.threadId;
        await thread.post("observed");
      },
    ),
  };
});

vi.mock("@/chat/app/factory", () => ({
  createSlackRuntime: vi.fn(() => ({
    handleNewMention: handleNewMentionMock,
    handleSubscribedMessage: noopAsync,
    handleAssistantThreadStarted: noopAsync,
    handleAssistantContextChanged: noopAsync,
  })),
}));

import { runEvalScenario } from "../../../evals/behavior-harness";

describe("behavior harness", () => {
  afterAll(() => {
    if (originalStateAdapterEnv === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
      return;
    }
    process.env.JUNIOR_STATE_ADAPTER = originalStateAdapterEnv;
  });

  afterEach(() => {
    observedRuntimeIds.threadId = undefined;
    observedRuntimeIds.messageThreadId = undefined;
    handleNewMentionMock.mockClear();
    noopAsync.mockClear();
  });

  it("normalizes eval thread fixtures to Slack-style runtime thread ids", async () => {
    const result = await runEvalScenario({
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
    expect(result.posts).toEqual([{ text: "observed", files: [] }]);
  });

  it("routes two same-thread mention-shaped events through the queued runtime in order", async () => {
    const thread = {
      id: "fixture-thread",
      channel_id: "C_QUEUE",
      thread_ts: "1700000000.0002",
    };

    const result = await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread,
          message: {
            id: "m-queue-1",
            text: "first",
            is_mention: true,
            author: {
              user_id: "U_QUEUE",
            },
          },
        },
        {
          type: "subscribed_message",
          thread,
          message: {
            id: "m-queue-2",
            text: "<@U_APP> second",
            is_mention: true,
            author: {
              user_id: "U_QUEUE",
            },
          },
        },
      ],
    });

    expect(handleNewMentionMock).toHaveBeenCalledTimes(2);
    expect(result.posts).toEqual([
      { text: "observed", files: [] },
      { text: "observed", files: [] },
    ]);
  });

  it("preserves attached file metadata on assistant thread posts", async () => {
    handleNewMentionMock.mockImplementationOnce(
      async (thread: { post: (value: unknown) => Promise<void> }) => {
        await thread.post({
          raw: "",
          files: [
            {
              data: Buffer.from("png"),
              filename: "generated.png",
              mimeType: "image/png",
            },
          ],
        });
      },
    );

    const result = await runEvalScenario({
      events: [
        {
          type: "new_mention",
          thread: {
            id: "fixture-media-thread",
            channel_id: "C_MEDIA",
            thread_ts: "1700000000.0003",
          },
          message: {
            id: "m-media-1",
            text: "show me how you feel",
            is_mention: true,
            author: {
              user_id: "U_MEDIA",
            },
          },
        },
      ],
    });

    expect(result.posts).toEqual([
      {
        text: "",
        files: [
          {
            filename: "generated.png",
            isImage: true,
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    ]);
  });
});
