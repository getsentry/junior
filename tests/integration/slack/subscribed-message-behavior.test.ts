import { afterEach, describe, expect, it } from "vitest";
import { appSlackRuntime, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

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
            reason: "side conversation"
          },
          text: "{\"should_reply\":false,\"confidence\":0,\"reason\":\"side conversation\"}"
        } as never;
      },
      generateAssistantReply: async () => {
        throw new Error("generateAssistantReply should not run when classifier skips reply");
      }
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002000.000" });
    const message = createTestMessage({
      id: "m-subscribed-skip",
      text: "sounds good thanks everyone",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" }
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
            reason: "explicit ask"
          },
          text: "{\"should_reply\":true,\"confidence\":1,\"reason\":\"explicit ask\"}"
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
            usedPrimaryText: true
          }
        };
      }
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002001.000" });
    const message = createTestMessage({
      id: "m-subscribed-reply",
      text: "can you suggest one concrete next step?",
      isMention: false,
      threadId: thread.id,
      author: { userId: "U_TESTER" }
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalls).toHaveLength(1);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("monitor dashboards");
  });

  it("bypasses classifier for explicit mentions in subscribed threads", async () => {
    let classifierCalled = false;
    const replyCalls: string[] = [];

    setBotDepsForTests({
      completeObject: async () => {
        classifierCalled = true;
        throw new Error("classifier should be bypassed for explicit mentions");
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
            usedPrimaryText: true
          }
        };
      }
    });

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700002002.000" });
    const message = createTestMessage({
      id: "m-subscribed-mention",
      text: "<@U_APP> quick status?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" }
    });

    await appSlackRuntime.handleSubscribedMessage(thread, message);

    expect(classifierCalled).toBe(false);
    expect(replyCalls).toHaveLength(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Shipping status is green");
  });
});
