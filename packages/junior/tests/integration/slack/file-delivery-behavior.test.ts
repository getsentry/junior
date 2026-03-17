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

describe("Slack behavior: file delivery", () => {
  afterEach(() => {
    resetBotDepsForTests();
  });

  it("ignores file followup plans when the assistant reply has no files", async () => {
    setBotDepsForTests({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onTextDelta?.("Preview is ready.");
        return {
          text: "Preview is ready.",
          deliveryPlan: {
            mode: "thread",
            ack: "none",
            postThreadText: true,
            attachFiles: "followup",
          },
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

    const thread = createTestThread({ id: "slack:C_FILES:1700004020.000" });
    const message = createTestMessage({
      id: "m-file-plan-1",
      text: "<@U_APP> show me the preview",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await appSlackRuntime.handleNewMention(thread, message);

    expect(thread.posts).toEqual(["Preview is ready."]);
  });
});
