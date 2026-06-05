import type { Message } from "chat";
import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { conversationMessages } from "../../fixtures/slack-behavior";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

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
    let replyCallCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
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

    expect(replyCallCount).toBe(1);
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Rollback is complete");
  });

  it("records queued SDK messages before the latest mention", async () => {
    let replyCallCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
            return {
              text: "Handled both updates.",
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
      id: "slack:C_QUEUED:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued",
      text: "<@U_APP> first queued request",
      isMention: true,
      threadId: thread.id,
    });
    const latest = createTestMessage({
      id: "m-latest",
      text: "<@U_APP> latest request",
      isMention: true,
      threadId: thread.id,
    });

    await slackRuntime.handleNewMention(thread, latest, {
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(replyCallCount).toBe(1);
    expect(
      conversationMessages(thread)
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
    }> = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            const attachments = context?.userAttachments ?? [];
            fakeReplyCalls.push({
              inboundAttachmentCount: context?.inboundAttachmentCount,
              filenames: attachments.map(
                (attachment) => attachment.filename ?? "",
              ),
              attachmentText: attachments[0]?.data?.toString("utf8"),
            });
            return {
              text: "Handled queued attachment.",
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
      id: "slack:C_QUEUED_ATTACHMENTS:1700001234.000",
    });
    const queued = createTestMessage({
      id: "m-queued-file",
      text: "<@U_APP> review this file first",
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
      text: "<@U_APP> then answer now",
      isMention: true,
      threadId: thread.id,
    });

    await slackRuntime.handleNewMention(thread, latest, {
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(fakeReplyCalls).toEqual([
      expect.objectContaining({
        inboundAttachmentCount: 1,
        filenames: ["queued-notes.txt"],
        attachmentText: "queued attachment notes",
      }),
    ]);
    expect(
      conversationMessages(thread)
        .filter(
          (message) =>
            message.id === "m-queued-file" || message.id === "m-latest-file",
        )
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      { id: "m-queued-file", text: "review this file first" },
      { id: "m-latest-file", text: "then answer now" },
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain(
      "Handled queued attachment.",
    );
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
