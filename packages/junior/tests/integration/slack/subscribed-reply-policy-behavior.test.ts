import { describe, expect, it } from "vitest";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import {
  conversationMessages,
  createSlackBehaviorRuntime,
  postedText,
} from "../../fixtures/slack/behavior";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack/harness";

describe("Slack behavior: subscribed reply policy", () => {
  it("routes acknowledgment text with attachments through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          classifierCalled = true;
          return {
            object: {
              should_reply: false,
              confidence: 0.95,
              reason: "attachment acknowledgment",
            },
            text: '{"should_reply":false,"confidence":0.95,"reason":"attachment acknowledgment"}',
          } as never;
        },
        generateAssistantReply: async () => {
          replyCalled = true;
          return successfulAssistantReply("This should never be posted.");
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.125" });
    const message = createTestMessage({
      id: "m-subscribed-ack-attachment",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      attachments: [
        {
          type: "image",
          url: "https://example.com/chart.png",
        },
      ],
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("routes legacy attachment-only passive messages through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          classifierCalled = true;
          return {
            object: {
              should_reply: false,
              confidence: 0.95,
              reason: "passive legacy attachment",
            },
            text: '{"should_reply":false,"confidence":0.95,"reason":"passive legacy attachment"}',
          } as never;
        },
        generateAssistantReply: async () => {
          replyCalled = true;
          return successfulAssistantReply("This should never be posted.");
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.275" });
    const message = createTestMessage({
      id: "m-subscribed-legacy-attachment-only",
      text: "",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
      raw: {
        channel: "C_BEHAVIOR",
        ts: "1700002003.275",
        thread_ts: "1700002003.275",
        attachments: [
          {
            fallback: "Deploy failed",
            fields: [{ title: "Service", value: "checkout" }],
          },
        ],
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(conversationMessages(thread)[0]?.text).toContain("Deploy failed");
    expect(conversationMessages(thread)[0]?.text).toContain(
      "Service: checkout",
    );
    expect(thread.posts).toHaveLength(0);
  });

  it("routes generic immediate attachment follow-ups through the classifier", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          classifierCalled = true;
          return {
            object: {
              should_reply: false,
              confidence: 0.95,
              reason: "attachment follow-up",
            },
            text: '{"should_reply":false,"confidence":0.95,"reason":"attachment follow-up"}',
          } as never;
        },
        generateAssistantReply: async () => {
          replyCalled = true;
          return successfulAssistantReply("This should never be posted.");
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.350" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-1",
        text: "<@U_APP> summarize the deploy",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );
    replyCalled = false;

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-generic-side-attachment-2",
        text: "can you check on this?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
        attachments: [
          {
            type: "image",
            url: "https://example.com/screenshot.png",
          },
        ],
      }),
    );

    expect(classifierCalled).toBe(true);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(1);
  });

  it("stays silent when a subscribed message is clearly directed at another bot", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          classifierCalled = true;
          throw new Error(
            "classifier should be bypassed for messages addressed to another bot",
          );
        },
        generateAssistantReply: async () => {
          replyCalled = true;
          return successfulAssistantReply("This should never be posted.");
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.500" });
    const message = createTestMessage({
      id: "m-subscribed-other-bot",
      text: "@Cursor can you help address issue 87?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(false);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
    const state = (await thread.state) ?? {};
    const conversation = (state.conversation ?? {}) as {
      messages?: Array<{
        id: string;
        text: string;
        meta?: { replied?: boolean; skippedReason?: string };
      }>;
      processing?: { lastCompletedAtMs?: number };
    };
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "m-subscribed-other-bot",
          text: "@Cursor can you help address issue 87?",
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "directed_to_other_party:named_mention:Cursor",
          }),
        }),
      ]),
    );
    expect(conversation.processing?.lastCompletedAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("replies immediately to directed follow-up questions after junior just spoke", async () => {
    let classifierCalled = false;
    let replyCallCount = 0;

    const { slackRuntime } = createSlackBehaviorRuntime({
      adapters: {
        classifySubscribedReply: async () => {
          classifierCalled = true;
          throw new Error(
            "classifier should be bypassed for directed follow-ups",
          );
        },
        generateAssistantReply: async () => {
          replyCallCount += 1;
          return successfulAssistantReply(
            replyCallCount === 1
              ? "Budget noted."
              : "You asked for the budget by Friday.",
          );
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002004.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-1",
        text: "<@U_APP> I need the budget by Friday",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-2",
        text: "what did you just say about the budget?",
        isMention: false,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(classifierCalled).toBe(false);
    expect(replyCallCount).toBe(2);
    expect(
      conversationMessages(thread).map((message) => ({
        id: message.id,
        text: message.text,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: "m-subscribed-followup-2",
          text: "what did you just say about the budget?",
        },
      ]),
    );
    expect(thread.posts).toHaveLength(2);
    expect(postedText(thread.posts[1])).toContain("budget by Friday");
  });
});
