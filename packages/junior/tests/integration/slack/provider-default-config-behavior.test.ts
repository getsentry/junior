import { describe, expect, it, vi } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { getPersistedChannelState } from "@/chat/runtime/thread-state";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";

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
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
        },
      },
    });
    const thread = await createTestThread({
      id: "slack:C0CONFIG:1700007007.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-config-1",
        text: "<@U0APP> Set the default repo to getsentry/junior.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(executeAgentRun).not.toHaveBeenCalled();
    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("getsentry/junior");
    await expect(getPersistedChannelState(thread.channelId)).resolves.toMatchObject({
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
    const executeAgentRun = vi.fn(async (request) => {
      await deliverAssistantMessagesForTest(request, [
        { text: "Created the issue." },
      ]);
      return completedAgentRun({
        text: "Created the issue.",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      });
    });
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
        },
      },
    });
    const thread = await createTestThread({
      id: "slack:C0CONFIGCOMBINED:1700007008.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-config-2",
        text: "<@U0APP> Set the default repo to getsentry/junior and create an issue for flaky evals.",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(executeAgentRun).toHaveBeenCalledOnce();
    expect(toPostedText(thread.posts[0])).toContain("Created the issue.");
    await expect(getPersistedChannelState(thread.channelId)).resolves.not.toMatchObject({
      configuration: {
        entries: {
          "github.repo": expect.anything(),
        },
      },
    });
  });
});
