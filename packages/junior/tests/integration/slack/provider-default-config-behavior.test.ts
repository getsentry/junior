import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { getLocationConfigurationService } from "@/chat/runtime/thread-state";
import {
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

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
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
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

    expect(thread.posts).toHaveLength(1);
    expect(toPostedText(thread.posts[0])).toContain("getsentry/junior");
    await expect(
      getLocationConfigurationService(createTestDestination(thread)).get(
        "github.repo",
      ),
    ).resolves.toMatchObject({
      key: "github.repo",
      value: "getsentry/junior",
      source: "provider-default-config",
    });
  });

  it("does not intercept combined repo setup and agent work", async () => {
    let agentRunCount = 0;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun(() => {
            agentRunCount += 1;
            return createModelStream([
              { type: "text", text: "Created the issue." },
            ]);
          }),
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

    expect(agentRunCount).toBe(1);
    expect(toPostedText(thread.posts[0])).toContain("Created the issue.");
    await expect(
      getLocationConfigurationService(createTestDestination(thread)).get(
        "github.repo",
      ),
    ).resolves.toBeUndefined();
  });
});
