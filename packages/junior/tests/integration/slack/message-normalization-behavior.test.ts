import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

interface CapturedCall {
  prompt: string;
}

describe("Slack behavior: message normalization", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("strips leading Slack mention token before invoking the agent", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "direct mention follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            calls.push({ prompt });
            return successfulAssistantReply("Summary sent.");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005000.000" });
    const message = createTestMessage({
      id: "m-content-strip",
      text: "<@U_APP>   please summarize the deploy status",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("please summarize the deploy status");
  });

  it("preserves non-leading mention tokens in user content", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            calls.push({ prompt });
            return successfulAssistantReply("Done.");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005001.000" });
    const message = createTestMessage({
      id: "m-content-preserve",
      text: "<@U_APP> remind me to message <@U_ONCALL> after deploy",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("message <@U_ONCALL> after deploy");
  });

  it("passes legacy attachment text into the current turn prompt", async () => {
    const calls: CapturedCall[] = [];

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (prompt) => {
            calls.push({ prompt });
            return successfulAssistantReply("Alert reviewed.");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005002.500" });
    const message = createTestMessage({
      id: "m-content-legacy-attachment",
      text: "<@U_APP>",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      raw: {
        channel: "C_BEHAVIOR",
        ts: "1700005002.500",
        thread_ts: "1700005002.500",
        attachments: [
          {
            fallback: "Deploy failed on production",
            title: "Production deploy",
            text: "OOM on pod-42",
            fields: [{ title: "Service", value: "checkout" }],
            footer: "Datadog Monitor",
          },
        ],
      },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Production deploy");
    expect(calls[0]?.prompt).toContain("OOM on pod-42");
    expect(calls[0]?.prompt).toContain("Service: checkout");
  });

  it("does not invoke the agent for self-authored mention messages", async () => {
    let replyCalled = false;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCalled = true;
            return successfulAssistantReply("Should not happen");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005002.000" });
    const message = createTestMessage({
      id: "m-content-self",
      text: "<@U_APP> do not respond",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U_BOT",
        isMe: true,
      },
    });

    await slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    });

    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });
});
