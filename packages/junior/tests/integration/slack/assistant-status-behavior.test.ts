import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  FakeSlackAdapter,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";

const emptyThreadReplies = async () => [];

function createRuntime(
  args: {
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    slackAdapter: args.slackAdapter,
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

describe("Slack behavior: assistant status", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("clears assistant status after successful reply", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(makeAssistantStatus("running", "bash"));
            return successfulAssistantReply("Done.", {
              diagnostics: {
                toolCalls: ["bash"],
                toolResultCount: 1,
              },
            });
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STATUS:1700002000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-clear",
        text: "<@U_APP> run a command",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700002000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("deletes redundant reply and clears status for reaction-only turn", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(makeAssistantStatus("drafting", "reply"));
            return successfulAssistantReply("Done!", {
              deliveryMode: "thread",
              diagnostics: {
                toolCalls: ["slackMessageAddReaction"],
                toolResultCount: 1,
              },
            });
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STATUS:1700004000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-reaction-only",
        text: "<@U_APP> add a reaction to this message",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.posts).toHaveLength(0);
    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700004000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("clears assistant status after agent error", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("model exploded");
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STATUS:1700003000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-error",
        text: "<@U_APP> do something",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700003000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("emits assistant status updates in shared channel threads", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(
              makeAssistantStatus("reading", "channel messages"),
            );
            return successfulAssistantReply("Done.");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_STATUS:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-status",
        threadId: thread.id,
        text: "show the channel",
        isMention: true,
      }),
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls[0]).toEqual(
      expect.objectContaining({
        channelId: "C_STATUS",
        threadTs: "1700000000.000",
      }),
    );
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700000000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("posts the final reply even while the initial assistant status write is pending", async () => {
    const slackAdapter = new FakeSlackAdapter();
    let releaseFirstStatus: (() => void) | undefined;
    let statusCallCount = 0;
    slackAdapter.setAssistantStatus = async (
      channelId,
      threadTs,
      text,
      loadingMessages,
    ) => {
      statusCallCount += 1;
      if (statusCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstStatus = resolve;
        });
      }
      slackAdapter.statusCalls.push({
        channelId,
        threadTs,
        text,
        loadingMessages,
      });
    };

    let replyStarted = false;
    const thread = createTestThread({
      id: "slack:D_STATUSORDER:1700000001.000",
    });
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Status thread" }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyStarted = true;
            return successfulAssistantReply(
              "Reply lands after the pending status is drained.",
            );
          },
        },
      },
    });

    let settled = false;
    const turnPromise = slackRuntime
      .handleNewMention(
        thread,
        createTestMessage({
          id: "msg-status-order",
          threadId: thread.id,
          text: "answer quickly",
          isMention: true,
        }),
      )
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(replyStarted).toBe(true);
      expect(thread.posts).toEqual([
        expect.objectContaining({
          markdown: "Reply lands after the pending status is drained.",
        }),
      ]);
    });

    expect(settled).toBe(false);

    releaseFirstStatus!();
    await turnPromise;
  });
});
