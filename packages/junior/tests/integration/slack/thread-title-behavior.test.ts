import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  FakeSlackAdapter,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";

const emptyThreadReplies = async () => [];

function postIncludes(thread: { posts: unknown[] }, text: string): boolean {
  return thread.posts.some((post) => {
    if (typeof post === "string") {
      return post.includes(text);
    }
    if (
      post &&
      typeof post === "object" &&
      "markdown" in (post as Record<string, unknown>)
    ) {
      return String((post as { markdown: string }).markdown).includes(text);
    }
    return false;
  });
}

function createRuntime(args: {
  services?: JuniorRuntimeServiceOverrides;
  slackAdapter: FakeSlackAdapter;
}) {
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

async function flushTitleWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function generatedTitleCall(adapter: FakeSlackAdapter) {
  return adapter.titleCalls.find((call) => call.title !== "Junior");
}

describe("Slack behavior: thread title", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("generates and sets title after first assistant reply", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Debugging Node.js Memory Leaks",
              message: { role: "assistant", content: "" },
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("Here is how to debug memory leaks."),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title-1",
        threadId: thread.id,
        text: "How do I debug memory leaks in Node?",
        isMention: true,
      }),
    );

    await flushTitleWork();

    expect(generatedTitleCall(slackAdapter)).toEqual(
      expect.objectContaining({
        channelId: "D_TITLE",
        threadTs: "1700000000.000",
        title: "Debugging Node.js Memory Leaks",
      }),
    );
  });

  it("uses the first human message we know about in the thread", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async (params) => {
            const prompt =
              typeof params.messages[0]?.content === "string"
                ? params.messages[0].content
                : "";
            return {
              text: prompt.includes("Original production issue summary")
                ? "Production Issue Summary"
                : "Follow-up Clarification",
              message: { role: "assistant", content: "" },
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("Here is the updated answer."),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE4:1700000000.000" });
    const earlierMessage = createTestMessage({
      id: "msg-title4-earlier",
      threadId: thread.id,
      text: "Original production issue summary",
      author: { userId: "U-title4", isBot: false },
    });
    earlierMessage.metadata.dateSent = new Date(1_700_000_000_000);
    thread.recentMessages = [earlierMessage];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title4-current",
        threadId: thread.id,
        text: "Can you also include the regression window?",
        isMention: true,
      }),
    );

    await flushTitleWork();

    expect(generatedTitleCall(slackAdapter)).toEqual(
      expect.objectContaining({
        title: "Production Issue Summary",
      }),
    );
  });

  it("still generates for a new thread with starter assistant content", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Today's Date",
              message: { role: "assistant", content: "" },
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("Today is April 16, 2026."),
        },
      },
    });

    const thread = createTestThread({
      id: "slack:D_TITLE5:1700000000.000",
    });
    const starterMessage = createTestMessage({
      id: "msg-title5-starter",
      threadId: thread.id,
      text: "How can I help?",
      author: {
        isBot: true,
        isMe: true,
        userId: "B-title5",
        userName: "junior",
      },
    });
    starterMessage.metadata.dateSent = new Date(1_700_000_000_000);
    thread.recentMessages = [starterMessage];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title5-user",
        threadId: thread.id,
        text: "what's today's date",
        isMention: true,
      }),
    );

    await flushTitleWork();

    expect(generatedTitleCall(slackAdapter)).toEqual(
      expect.objectContaining({
        title: "Today's Date",
      }),
    );
  });

  it("runs in parallel with reply delivery when generation is slow", async () => {
    const slackAdapter = new FakeSlackAdapter();
    let resolveTitle: (() => void) | undefined;
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            await new Promise((resolve) => {
              resolveTitle = () =>
                resolve({
                  text: "Today's Date",
                  message: { role: "assistant", content: "" },
                } as never);
            }),
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("Today is April 16, 2026."),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE6:1700000000.000" });
    let settled = false;
    const turnPromise = slackRuntime
      .handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-6",
          threadId: thread.id,
          text: "what's today's date",
          isMention: true,
        }),
      )
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(postIncludes(thread, "Today is April 16, 2026.")).toBe(true);
    });
    expect(settled).toBe(false);

    resolveTitle!();
    await turnPromise;
  });

  it("does not generate title on subsequent replies", async () => {
    const slackAdapter = new FakeSlackAdapter();
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Some Title",
              message: { role: "assistant", content: "" },
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            turnCount += 1;
            return successfulAssistantReply(`reply-${turnCount}`);
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE2:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-1",
        threadId: thread.id,
        text: "first message",
        isMention: true,
      }),
    );
    await flushTitleWork();

    expect(
      slackAdapter.titleCalls.filter((call) => call.title !== "Junior"),
    ).toHaveLength(1);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-2",
        threadId: thread.id,
        text: "second message",
        isMention: true,
      }),
    );
    await flushTitleWork();

    expect(
      slackAdapter.titleCalls.filter((call) => call.title !== "Junior"),
    ).toHaveLength(1);
  });

  it("ignores Slack permission errors when setting title", async () => {
    const slackAdapter = new FakeSlackAdapter();
    slackAdapter.setAssistantTitle = async () => {
      const error = new Error(
        "An API error occurred: no_permission",
      ) as Error & {
        data?: { error?: string };
      };
      error.data = { error: "no_permission" };
      throw error;
    };
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Permission Safe Title",
              message: { role: "assistant", content: "" },
            }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("This reply should still succeed."),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE3:1700000000.000" });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-3",
          threadId: thread.id,
          text: "title this thread please",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();
    await flushTitleWork();
    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it("does not regenerate after stable Slack permission failures", async () => {
    const slackAdapter = new FakeSlackAdapter();
    slackAdapter.setAssistantTitle = async () => {
      const error = new Error(
        "An API error occurred: no_permission",
      ) as Error & {
        data?: { error?: string };
      };
      error.data = { error: "no_permission" };
      throw error;
    };

    let titleGenerationCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter,
      services: {
        conversationMemory: {
          completeText: async () => {
            titleGenerationCount += 1;
            return {
              text: "Stable Permission Title",
              message: { role: "assistant", content: "" },
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply("Reply still succeeds."),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE7:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-1",
        threadId: thread.id,
        text: "first message",
        isMention: true,
      }),
    );
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-2",
        threadId: thread.id,
        text: "second message",
        isMention: true,
      }),
    );

    expect(titleGenerationCount).toBe(1);
  });
});
