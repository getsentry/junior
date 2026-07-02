import type { Message } from "chat";
import { describe, expect, it } from "vitest";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import {
  FakeSlackAdapter,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

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

function completedReply(text: string, toolCalls: string[] = []) {
  return completedAgentRun({
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-agent-model",
      outcome: "success" as const,
      toolCalls,
      toolErrorCount: 0,
      toolResultCount: toolCalls.length,
      usedPrimaryText: true,
    },
  });
}

describe("Slack behavior: new mention", () => {
  it("handles a mention with real runtime wiring and fake agent response", async () => {
    const fakeReplyCalls: FakeReplyCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;

              fakeReplyCalls.push({ prompt });
              return completedReply(
                "Acknowledged. Rollback is complete and error rates are stable.",
              );
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0BEHAVIOR:1700001234.000",
    });
    const message = createTestMessage({
      id: "m-behavior-1",
      text: "<@U0APP> give me a status update",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U0TESTER",
        userName: "tester",
      },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(fakeReplyCalls).toHaveLength(1);
    expect(fakeReplyCalls[0]?.prompt).toContain("give me a status update");
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Rollback is complete");
  });

  it("includes queued SDK messages in the assistant prompt", async () => {
    const fakeReplyCalls: FakeReplyCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;

              fakeReplyCalls.push({ prompt });
              return completedReply("Handled both updates.");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0QUEUED:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued",
      text: "<@U0APP> first queued request",
      isMention: true,
      threadId: thread.id,
    });
    const latest = createTestMessage({
      id: "m-latest",
      text: "<@U0APP> latest request",
      isMention: true,
      threadId: thread.id,
    });

    await slackRuntime.handleNewMention(thread, latest, {
      destination: createTestDestination(thread),
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(fakeReplyCalls).toHaveLength(1);
    expect(fakeReplyCalls[0]?.prompt).toContain("first queued request");
    expect(fakeReplyCalls[0]?.prompt).toContain("latest request");
    expect(
      fakeReplyCalls[0]?.prompt.indexOf("first queued request"),
    ).toBeLessThan(fakeReplyCalls[0]?.prompt.indexOf("latest request") ?? -1);
    const state = thread.getState() as {
      conversation?: {
        messages?: Array<{ id: string; text: string }>;
      };
    };
    expect(
      state.conversation?.messages
        ?.filter(
          (message) => message.id === "m-queued" || message.id === "m-latest",
        )
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: "m-queued", text: "first queued request" },
      { id: "m-latest", text: "latest request" },
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Handled both updates.");
  });

  it("forwards queued SDK message attachments to the assistant context", async () => {
    const fakeReplyCalls: Array<{
      attachmentText?: string;
      filenames: string[];
      inboundAttachmentCount?: number;
      prompt: string;
    }> = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              const attachments = context?.userAttachments ?? [];
              fakeReplyCalls.push({
                prompt,
                inboundAttachmentCount: context?.inboundAttachmentCount,
                filenames: attachments.map(
                  (attachment) => attachment.filename ?? "",
                ),
                attachmentText: attachments[0]?.data?.toString("utf8"),
              });
              return completedReply("Handled queued attachment.");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0QUEUEDATTACHMENTS:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued-file",
      text: "<@U0APP> review this file first",
      isMention: true,
      threadId: thread.id,
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          name: "queued-notes.txt",
          data: Buffer.from("queued attachment notes"),
        },
      ] as Message["attachments"],
    });
    const latest = createTestMessage({
      id: "m-latest-file",
      text: "<@U0APP> then answer now",
      isMention: true,
      threadId: thread.id,
    });

    await slackRuntime.handleNewMention(thread, latest, {
      destination: createTestDestination(thread),
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(fakeReplyCalls).toEqual([
      expect.objectContaining({
        prompt: expect.stringContaining("review this file first"),
        inboundAttachmentCount: 1,
        filenames: ["queued-notes.txt"],
        attachmentText: "queued attachment notes",
      }),
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "Handled queued attachment.",
    );
  });

  it("clears assistant status after successful reply", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onStatus?.(makeAssistantStatus("running", "bash"));
              return completedReply("Done.", ["bash"]);
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0STATUS:1700002000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-clear",
        text: "<@U0APP> run a command",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C0STATUS",
      threadTs: "1700002000.000",
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
          agentRunner: {
            run: async () => {
              throw new Error("model exploded");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0STATUS:1700003000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-error",
        text: "<@U0APP> do something",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C0STATUS",
      threadTs: "1700003000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("suppresses thread reply when assistant marks delivery as channel_only", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              return completedAgentRun({
                text: "Posted in channel.",
                deliveryMode: "channel_only" as const,
                diagnostics: {
                  assistantMessageCount: 1,
                  modelId: "fake-agent-model",
                  outcome: "success" as const,
                  toolCalls: ["sendMessage"],
                  toolErrorCount: 0,
                  toolResultCount: 1,
                  usedPrimaryText: true,
                },
              });
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C0BEHAVIOR:1700005678.000",
    });
    const message = createTestMessage({
      id: "m-behavior-2",
      text: "<@U0APP> say hello to the channel",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U0TESTER",
        userName: "tester",
      },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(0);
  });
});
