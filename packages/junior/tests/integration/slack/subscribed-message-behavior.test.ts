import { describe, expect, it } from "vitest";
import { createProviderError } from "@/chat/services/provider-retry";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  conversationMessages,
  createSlackBehaviorRuntime,
  postedText,
} from "../../fixtures/slack-behavior";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

describe("Slack behavior: subscribed messages", () => {
  it("skips reply when classifier says not to reply", async () => {
    let classifierCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCallCount += 1;
            return {
              object: {
                should_reply: false,
                confidence: 0,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error(
              "generateAssistantReply should not run when classifier skips reply",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002000.000" });
    const message = createTestMessage({
      id: "m-subscribed-skip",
      text: "sounds good thanks everyone",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCallCount).toBe(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("rethrows retryable classifier provider errors for durable retry", async () => {
    const providerError = createProviderError(
      new Error("Anthropic stream ended before message_stop"),
    );

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            throw providerError;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("generateAssistantReply should not run");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002000.001" });
    const message = createTestMessage({
      id: "m-subscribed-provider-retry",
      text: "can you check this?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await expect(
      slackRuntime.handleSubscribedMessage(thread, message),
    ).rejects.toBe(providerError);
    expect(thread.posts).toHaveLength(0);
  });

  it("replies when classifier approves a subscribed-thread message", async () => {
    let classifierCallCount = 0;
    let replyCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCallCount += 1;
            return {
              object: {
                should_reply: true,
                confidence: 1,
                reason: "explicit ask",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"explicit ask"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
            return successfulAssistantReply(
              "Action item captured: monitor dashboards for 30 minutes.",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002001.000" });
    const message = createTestMessage({
      id: "m-subscribed-reply",
      text: "can you suggest one concrete next step?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCallCount).toBe(1);
    expect(replyCallCount).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(postedText(thread.posts[0])).toContain("monitor dashboards");
  });

  it("replies directly to explicit mentions in subscribed threads", async () => {
    let classifierCalled = false;
    let replyCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for explicit mentions",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
            return successfulAssistantReply("Yes. Shipping status is green.");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.000" });
    const message = createTestMessage({
      id: "m-subscribed-mention",
      text: "<@U_APP> quick status?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(false);
    expect(replyCallCount).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(postedText(thread.posts[0])).toContain("Shipping status is green");
  });

  it("treats queued explicit mentions as part of the subscribed turn", async () => {
    let classifierCalled = false;
    let replyCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            throw new Error(
              "classifier should be bypassed for queued explicit mentions",
            );
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
            return successfulAssistantReply("Handled queued subscribed turn.");
          },
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700002002.250",
    });
    const queued = createTestMessage({
      id: "m-subscribed-queued-mention",
      text: "<@U_APP> first queued request",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const latest = createTestMessage({
      id: "m-subscribed-queued-latest",
      text: "latest follow-up",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, latest, {
      messageContext: {
        skipped: [queued],
        totalSinceLastHandler: 2,
      },
    });

    expect(classifierCalled).toBe(false);
    expect(replyCallCount).toBe(1);
    expect(
      conversationMessages(thread)
        .filter(
          (message) =>
            message.id === "m-subscribed-queued-mention" ||
            message.id === "m-subscribed-queued-latest",
        )
        .map((message) => ({ id: message.id, text: message.text })),
    ).toEqual([
      {
        id: "m-subscribed-queued-mention",
        text: "first queued request",
      },
      { id: "m-subscribed-queued-latest", text: "latest follow-up" },
    ]);
    expect(thread.posts).toHaveLength(1);
    expect(postedText(thread.posts[0])).toContain(
      "Handled queued subscribed turn.",
    );
  });

  it("unsubscribes on explicit stop-thread instructions and only re-engages on a later direct mention", async () => {
    let classifierCalled = false;
    let replyCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            classifierCalled = true;
            return {
              object: {
                should_reply: false,
                should_unsubscribe: true,
                confidence: 1,
                reason:
                  "user explicitly asked junior to stop participating in the thread",
              },
              text: '{"should_reply":false,"should_unsubscribe":true,"confidence":1,"reason":"user explicitly asked junior to stop participating in the thread"}',
            } as never;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyCallCount += 1;
            return successfulAssistantReply(
              replyCallCount === 1
                ? "I can help with this thread."
                : "I'm back because you mentioned me again.",
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.500" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-initial",
        text: "<@U_APP> can you help here?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(thread.subscribed).toBe(true);

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-stop-thread-opt-out",
        text: "<@U_APP> stop watching or participating in this thread",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(classifierCalled).toBe(false);
    expect(replyCallCount).toBe(1);
    expect(thread.subscribed).toBe(false);
    expect(postedText(thread.posts[1])).toContain(
      "I'll stay out of this thread unless someone @mentions me again.",
    );

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-remention",
        text: "<@U_APP> actually, can you jump back in?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(replyCallCount).toBe(2);
    expect(thread.subscribed).toBe(true);
    expect(postedText(thread.posts[2])).toContain(
      "I'm back because you mentioned me again.",
    );
  });
});
