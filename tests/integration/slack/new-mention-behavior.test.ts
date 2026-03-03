import { afterEach, describe, expect, it } from "vitest";
import { appSlackRuntime, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";

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
  afterEach(() => {
    resetBotDepsForTests();
  });

  it("handles a mention with real runtime wiring and fake agent response", async () => {
    const fakeReplyCalls: FakeReplyCall[] = [];

    setBotDepsForTests({
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
            usedPrimaryText: true
          }
        };
      }
    });

    const thread = createTestThread({
      id: "slack:C_BEHAVIOR:1700001234.000"
    });
    const message = createTestMessage({
      id: "m-behavior-1",
      text: "<@U_APP> give me a status update",
      isMention: true,
      threadId: thread.id,
      author: {
        userId: "U_TESTER",
        userName: "tester"
      }
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(fakeReplyCalls).toHaveLength(1);
    expect(fakeReplyCalls[0]?.prompt).toContain("give me a status update");
    expect(thread.subscribeCalls).toBe(1);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Rollback is complete");
  });
});
