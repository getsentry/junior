import { afterEach, describe, expect, it } from "vitest";
import {
  appSlackRuntime,
  resetBotDepsForTests,
  setBotDepsForTests,
} from "@/chat/bot";
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

describe("Slack behavior: subscribed messages", () => {
  afterEach(() => {
    resetBotDepsForTests();
  });

  it("skips reply when classifier says not to reply", async () => {
    const classifierCalls: string[] = [];

    setBotDepsForTests({
      completeObject: async (params: { prompt?: unknown }) => {
        classifierCalls.push(String(params.prompt));
        return {
          object: {
            should_reply: false,
            confidence: 0,
            reason: "side conversation",
          },
          text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
        } as never;
      },
      generateAssistantReply: async () => {
        throw new Error(
          "generateAssistantReply should not run when classifier skips reply",
        );
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

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(0);
  });

  it("replies when classifier approves a subscribed-thread message", async () => {
    const classifierCalls: string[] = [];
    const replyCalls: string[] = [];

    setBotDepsForTests({
      completeObject: async (params: { prompt?: unknown }) => {
        classifierCalls.push(String(params.prompt));
        return {
          object: {
            should_reply: true,
            confidence: 1,
            reason: "explicit ask",
          },
          text: '{"should_reply":true,"confidence":1,"reason":"explicit ask"}',
        } as never;
      },
      generateAssistantReply: async (prompt) => {
        replyCalls.push(prompt);
        return {
          text: "Action item captured: monitor dashboards for 30 minutes.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002001.000" });
    const message = createTestMessage({
      id: "m-subscribed-reply",
      text: "can you suggest one concrete next step?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalls).toHaveLength(1);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("monitor dashboards");
  });

  it("uses the router for explicit mentions in subscribed threads", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    setBotDepsForTests({
      completeObject: async () => {
        classifierCalled = true;
        return {
          object: {
            should_reply: true,
            confidence: 1,
            reason: "direct mention asking junior for status",
          },
          text: '{"should_reply":true,"confidence":1,"reason":"direct mention asking junior for status"}',
        } as never;
      },
      generateAssistantReply: async (prompt) => {
        replyCalls.push(prompt);
        return {
          text: "Yes. Shipping status is green.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.000" });
    const message = createTestMessage({
      id: "m-subscribed-mention",
      text: "<@U_APP> quick status?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(true);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Shipping status is green");
  });

  it("unsubscribes on explicit stop-thread instructions and only re-engages on a later direct mention", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    setBotDepsForTests({
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
      generateAssistantReply: async (prompt) => {
        replyCalls.push(prompt);
        return {
          text:
            replyCalls.length === 1
              ? "I can help with this thread."
              : "I'm back because you mentioned me again.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.500" });

    await appSlackRuntime.handleNewMention(
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

    await appSlackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "m-stop-thread-opt-out",
        text: "<@U_APP> stop watching or participating in this thread",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(classifierCalled).toBe(true);
    expect(replyCalls).toHaveLength(1);
    expect(thread.subscribed).toBe(false);
    expect(toPostedText(thread.posts[1])).toContain(
      "I'll stay out of this thread unless someone @mentions me again.",
    );

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-stop-thread-remention",
        text: "<@U_APP> actually, can you jump back in?",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    expect(replyCalls).toHaveLength(2);
    expect(thread.subscribed).toBe(true);
    expect(toPostedText(thread.posts[2])).toContain(
      "I'm back because you mentioned me again.",
    );
  });

  it("bypasses classifier for acknowledgment-only messages", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    setBotDepsForTests({
      completeObject: async () => {
        classifierCalled = true;
        throw new Error("classifier should be bypassed for acknowledgments");
      },
      generateAssistantReply: async () => {
        replyCalled = true;
        return {
          text: "This should never be posted.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.000" });
    const message = createTestMessage({
      id: "m-subscribed-ack",
      text: "thanks!",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(false);
    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("stays silent when a subscribed message is clearly directed at another bot", async () => {
    let classifierCalled = false;
    let replyCalled = false;

    setBotDepsForTests({
      completeObject: async () => {
        classifierCalled = true;
        throw new Error(
          "classifier should be bypassed for messages addressed to another bot",
        );
      },
      generateAssistantReply: async () => {
        replyCalled = true;
        return {
          text: "This should never be posted.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002003.500" });
    const message = createTestMessage({
      id: "m-subscribed-other-bot",
      text: "@Cursor can you help address issue 87?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

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

  it("bypasses classifier for assistant-directed follow-up questions", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    setBotDepsForTests({
      completeObject: async () => {
        classifierCalled = true;
        throw new Error(
          "classifier should be bypassed for follow-up questions",
        );
      },
      generateAssistantReply: async (prompt) => {
        replyCalls.push(prompt);
        return {
          text: "You asked for the budget by Friday.",
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
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002004.000" });
    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-subscribed-followup-1",
        text: "<@U_APP> I need the budget by Friday",
        isMention: true,
        threadId: thread.id,
        author: { userId: "U_TESTER" },
      }),
    );

    await appSlackRuntime.handleSubscribedMessage(
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
    expect(replyCalls).toContain("what did you just say about the budget?");
    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[1])).toContain("budget by Friday");
  });
});
