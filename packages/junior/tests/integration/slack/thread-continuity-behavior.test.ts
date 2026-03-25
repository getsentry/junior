import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { RetryableTurnError } from "@/chat/runtime/turn";

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

describe("Slack behavior: thread continuity", () => {
  it("keeps same-thread replies in arrival order for rapid follow-up messages", async () => {
    const scriptedReplies = [
      "Rollback complete. Error rates are back to baseline.",
      "Next step: monitor dashboards for 30 minutes.",
    ];
    const prompts: string[] = [];

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
            prompts.push(prompt);
            return {
              text:
                scriptedReplies[prompts.length - 1] ?? "Unexpected extra reply",
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

    const thread = createTestThread({ id: "slack:C_BEHAVIOR:1700003000.000" });
    const firstMessage = createTestMessage({
      id: "m-continuity-1",
      text: "<@U_APP> We rolled back the deploy after a 500 spike. Give me a status update.",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });
    const secondMessage = createTestMessage({
      id: "m-continuity-2",
      text: "<@U_APP> Also give one concrete next step for follow-up.",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, firstMessage);
    await slackRuntime.handleSubscribedMessage(thread, secondMessage);

    expect(prompts).toHaveLength(2);
    expect(thread.posts).toHaveLength(2);
    expect(toPostedText(thread.posts[0])).toContain("Rollback complete");
    expect(toPostedText(thread.posts[1])).toContain(
      "Next step: monitor dashboards",
    );
  });

  it("retryable timeout re-throws without posting an error message", async () => {
    let callCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            callCount += 1;
            if (callCount === 1) {
              throw new RetryableTurnError(
                "agent_turn_timeout_resume",
                "simulated timeout",
              );
            }
            return {
              text: "Status is stable.",
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

    const thread = createTestThread({ id: "slack:C_RETRY:1700006000.000" });
    const message = createTestMessage({
      id: "m-retry-1",
      text: "<@U_APP> What's the status of the deploy?",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    // First attempt: runtime re-throws RetryableTurnError (queue would retry)
    await expect(
      slackRuntime.handleNewMention(thread, message),
    ).rejects.toThrow(RetryableTurnError);
    expect(thread.posts).toHaveLength(0);

    // Second attempt: succeeds without error message
    await slackRuntime.handleNewMention(thread, message);
    expect(callCount).toBe(2);
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("Status is stable");
  });
});
