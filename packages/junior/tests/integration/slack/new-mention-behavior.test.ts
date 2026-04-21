import { describe, expect, it } from "vitest";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import { FakeSlackAdapter } from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

interface FakeReplyCall {
  prompt: string;
}

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
}

describe("Slack behavior: new mention", () => {
  it("handles a mention with real runtime wiring and fake agent response", async () => {
    const fakeReplyCalls: FakeReplyCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            fakeReplyCalls.push({ prompt });
            return {
              text: "Acknowledged. Rollback is complete and error rates are stable.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700001234.000",
    });
    const message = createTestMessage({
      id: "m-behavior-1",
      text: "<@U_APP> give me a status update",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U_TESTER",
        userName: "tester",
      },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(fakeReplyCalls).toHaveLength(1);
    expect(fakeReplyCalls[0]?.prompt).toContain("give me a status update");
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Rollback is complete");
  });

  it("clears assistant status after successful reply", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(makeAssistantStatus("running", "bash"));
            return {
              text: "Done.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: ["bash"],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
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

  it("derives a concrete progress phase from tool calls before the final reply", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onToolCall?.("webFetch", {
              url: "https://docs.slack.dev/ai/developing-agents/",
            });
            await new Promise((resolve) => setTimeout(resolve, 1300));
            return {
              text: "Across the provided Slack docs, agents use assistant status while work is in flight and post only finalized thread replies.",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: ["webFetch"],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STATUS:1700002500.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-tool-progress",
        text: "<@U_APP> summarize these docs",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(slackAdapter.statusCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "C_STATUS",
          threadTs: "1700002500.000",
          text: "is working on your request...",
          loadingMessages: ["Reading docs.slack.dev"],
        }),
      ]),
    );
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700002500.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("deletes redundant reply and clears status for reaction-only turn", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(makeAssistantStatus("drafting", "reply"));
            return {
              text: "Done!",
              deliveryMode: "thread",

              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: ["slackMessageAddReaction"],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
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

    // Reply posted then deleted to complete Slack's response cycle without visible noise
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
    const { slackRuntime } = createTestChatRuntime({
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

  it("suppresses thread reply when assistant marks delivery as channel_only", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            return {
              text: "Posted in channel.",
              deliveryMode: "channel_only",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success",
                toolCalls: ["slackChannelPostMessage"],
                toolErrorCount: 0,
                toolResultCount: 1,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700005678.000",
    });
    const message = createTestMessage({
      id: "m-behavior-2",
      text: "<@U_APP> say hello to the channel",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U_TESTER",
        userName: "tester",
      },
    });

    await slackRuntime.handleNewMention(thread, message);

    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(0);
  });
});
