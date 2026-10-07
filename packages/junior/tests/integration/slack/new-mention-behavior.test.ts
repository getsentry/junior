import { describe, expect, it } from "vitest";
import {
  FakeSlackAdapter,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { createModelAgentRunner } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";

describe("Slack behavior: new mention", () => {
  it("clears assistant status after agent error", async () => {
    const slackAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter,
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            { type: "error", errorMessage: "model exploded" },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0STATUS:1700003000.000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-status-error",
        text: "<@U0APP> do something",
        isMention: true,
        threadId: thread.id,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(slackAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C0STATUS",
      threadTs: "1700003000.000",
      text: "",
      loadingMessages: undefined,
    });
  });
});
