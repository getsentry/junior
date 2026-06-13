import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeScenarioAdapters } from "@/chat/app/services";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  FakeSlackAdapter,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { conversationMessages } from "../../fixtures/slack/behavior";

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
  adapters?: JuniorRuntimeScenarioAdapters;
  slackAdapter: FakeSlackAdapter;
}) {
  const adapters = args.adapters ?? {};
  return createTestChatRuntime({
    slackAdapter: args.slackAdapter,
    adapters: {
      listThreadReplies: emptyThreadReplies,
      ...adapters,
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
      adapters: {
        generateThreadTitleText: async () =>
          ({
            text: "Debugging Node.js Memory Leaks",
            message: { role: "assistant", content: "" },
          }) as never,
        generateAssistantReply: async () =>
          successfulAssistantReply("Here is how to debug memory leaks."),
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

  it("hydrates earlier human thread messages before generating a title", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter,
      adapters: {
        generateThreadTitleText: async () =>
          ({
            text: "Production Issue Summary",
            message: { role: "assistant", content: "" },
          }) as never,
        generateAssistantReply: async () =>
          successfulAssistantReply("Here is the updated answer."),
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

    expect(
      conversationMessages(thread)
        .filter(
          (message) =>
            message.id === "msg-title4-earlier" ||
            message.id === "msg-title4-current",
        )
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      {
        id: "msg-title4-earlier",
        text: "Original production issue summary",
      },
      {
        id: "msg-title4-current",
        text: "Can you also include the regression window?",
      },
    ]);
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
      adapters: {
        generateThreadTitleText: async () =>
          ({
            text: "Today's Date",
            message: { role: "assistant", content: "" },
          }) as never,
        generateAssistantReply: async () =>
          successfulAssistantReply("Today is April 16, 2026."),
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
      adapters: {
        generateThreadTitleText: async () =>
          await new Promise((resolve) => {
            resolveTitle = () =>
              resolve({
                text: "Today's Date",
                message: { role: "assistant", content: "" },
              } as never);
          }),
        generateAssistantReply: async () =>
          successfulAssistantReply("Today is April 16, 2026."),
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
    await turnPromise;
    expect(settled).toBe(true);

    resolveTitle!();
    await flushTitleWork();
    expect(generatedTitleCall(slackAdapter)).toMatchObject({
      title: "Today's Date",
    });
  });

  it("does not generate title on subsequent replies", async () => {
    const slackAdapter = new FakeSlackAdapter();
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter,
      adapters: {
        generateThreadTitleText: async () =>
          ({
            text: "Some Title",
            message: { role: "assistant", content: "" },
          }) as never,
        generateAssistantReply: async () => {
          turnCount += 1;
          return successfulAssistantReply(`reply-${turnCount}`);
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
      adapters: {
        generateThreadTitleText: async () =>
          ({
            text: "Permission Safe Title",
            message: { role: "assistant", content: "" },
          }) as never,
        generateAssistantReply: async () =>
          successfulAssistantReply("This reply should still succeed."),
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
      adapters: {
        generateThreadTitleText: async () => {
          titleGenerationCount += 1;
          return {
            text: "Stable Permission Title",
            message: { role: "assistant", content: "" },
          } as never;
        },
        generateAssistantReply: async () =>
          successfulAssistantReply("Reply still succeeds."),
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
