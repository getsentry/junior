import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { conversationMessages } from "../../fixtures/slack/behavior";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";

describe("Slack behavior: message normalization", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("strips leading Slack mention token before invoking the agent", async () => {
    let replyCallCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          return {
            object: {
              should_reply: true,
              confidence: 1,
              reason: "direct mention follow-up",
            },
            text: '{"should_reply":true,"confidence":1,"reason":"direct mention follow-up"}',
          } as never;
        },
        generateAssistantReply: async () => {
          replyCallCount += 1;
          return successfulAssistantReply("Summary sent.");
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

    expect(replyCallCount).toBe(1);
    expect(conversationMessages(thread)[0]?.text).toBe(
      "please summarize the deploy status",
    );
  });

  it("preserves non-leading mention tokens in user content", async () => {
    let replyCallCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        generateAssistantReply: async () => {
          replyCallCount += 1;
          return successfulAssistantReply("Done.");
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

    expect(replyCallCount).toBe(1);
    expect(conversationMessages(thread)[0]?.text).toContain(
      "message <@U_ONCALL> after deploy",
    );
  });

  it("passes legacy attachment text into the current turn prompt", async () => {
    let replyCallCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        generateAssistantReply: async () => {
          replyCallCount += 1;
          return successfulAssistantReply("Alert reviewed.");
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

    expect(replyCallCount).toBe(1);
    expect(conversationMessages(thread)[0]?.text).toContain(
      "Production deploy",
    );
    expect(conversationMessages(thread)[0]?.text).toContain("OOM on pod-42");
    expect(conversationMessages(thread)[0]?.text).toContain(
      "Service: checkout",
    );
  });

  it("does not invoke the agent for self-authored mention messages", async () => {
    let replyCalled = false;

    const { slackRuntime } = createTestChatRuntime({
      adapters: {
        generateAssistantReply: async () => {
          replyCalled = true;
          return successfulAssistantReply("Should not happen");
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
