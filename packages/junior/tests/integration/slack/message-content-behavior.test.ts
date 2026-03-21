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

interface CapturedCall {
  contextConversation?: string;
  prompt: string;
}

describe("Slack behavior: message content", () => {
  afterEach(() => {
    resetBotDepsForTests();
  });

  it("strips leading Slack mention token before invoking the agent", async () => {
    const calls: CapturedCall[] = [];

    setBotDepsForTests({
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
      generateAssistantReply: async (prompt, context) => {
        calls.push({
          prompt,
          contextConversation: context?.conversationContext,
        });
        return {
          text: "Summary sent.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005000.000" });
    const message = createTestMessage({
      id: "m-content-strip",
      text: "<@U_APP>   please summarize the deploy status",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("please summarize the deploy status");
  });

  it("preserves non-leading mention tokens in user content", async () => {
    const calls: CapturedCall[] = [];

    setBotDepsForTests({
      generateAssistantReply: async (prompt) => {
        calls.push({ prompt });
        return {
          text: "Done.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005001.000" });
    const message = createTestMessage({
      id: "m-content-preserve",
      text: "<@U_APP> remind me to message <@U_ONCALL> after deploy",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("message <@U_ONCALL> after deploy");
  });

  it("does not invoke the agent for self-authored mention messages", async () => {
    let replyCalled = false;

    setBotDepsForTests({
      generateAssistantReply: async () => {
        replyCalled = true;
        return {
          text: "Should not happen",
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

    await appSlackRuntime.handleNewMention(thread, message);

    expect(replyCalled).toBe(false);
    expect(thread.posts).toHaveLength(0);
  });

  it("carries prior turn context into the next turn", async () => {
    const calls: CapturedCall[] = [];

    setBotDepsForTests({
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
      generateAssistantReply: async (prompt, context) => {
        calls.push({
          prompt,
          contextConversation: context?.conversationContext,
        });
        return {
          text: calls.length === 1 ? "First response." : "Second response.",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700005003.000" });
    const first = createTestMessage({
      id: "m-content-context-1",
      text: "<@U_APP> I need the budget by Friday",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const second = createTestMessage({
      id: "m-content-context-2",
      text: "<@U_APP> what did I just ask?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleNewMention(thread, first);
    await appSlackRuntime.handleSubscribedMessage(thread, second);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.contextConversation ?? "").toContain("budget by Friday");
  });
});
