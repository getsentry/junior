import { describe, expect, it, vi } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
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

describe("Slack behavior: provider default configuration", () => {
  it("sets an explicit default GitHub repo without starting an agent turn", async () => {
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });
    const channelStateRef = { value: {} };
    const thread = createTestThread({
      id: "slack:C_CONFIG:1700007007.000",
      channelStateRef,
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-config-1",
        text: "<@U_APP> Set the default repo to getsentry/junior.",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("getsentry/junior");
    expect(channelStateRef.value).toMatchObject({
      configuration: {
        entries: {
          "github.repo": {
            key: "github.repo",
            value: "getsentry/junior",
            source: "provider-default-config",
          },
        },
      },
    });
  });

  it("does not intercept combined repo setup and agent work", async () => {
    const generateAssistantReply = vi.fn(async () => ({
      text: "Created the issue.",
      deliveryMode: "thread" as const,
      deliveryPlan: {
        mode: "thread" as const,
        postThreadText: true,
        attachFiles: "none" as const,
      },
      diagnostics: {
        assistantMessageCount: 1,
        modelId: "test-model",
        outcome: "success" as const,
        toolCalls: [],
        toolErrorCount: 0,
        toolResultCount: 0,
        usedPrimaryText: true,
      },
    }));
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });
    const channelStateRef = { value: {} };
    const thread = createTestThread({
      id: "slack:C_CONFIG_COMBINED:1700007008.000",
      channelStateRef,
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-config-2",
        text: "<@U_APP> Set the default repo to getsentry/junior and create an issue for flaky evals.",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(generateAssistantReply).toHaveBeenCalledOnce();
    expect(toPostedText(thread.posts[0])).toContain("Created the issue.");
    expect(channelStateRef.value).not.toMatchObject({
      configuration: {
        entries: {
          "github.repo": expect.anything(),
        },
      },
    });
  });
});
