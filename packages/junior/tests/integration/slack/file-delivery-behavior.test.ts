import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

describe("Slack behavior: file delivery", () => {
  it("ignores file followup plans when the assistant reply has no files", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Preview is ready.");
            return {
              text: "Preview is ready.",
              deliveryPlan: {
                mode: "thread",

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
        },
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

    await slackRuntime.handleNewMention(thread, message);

    expect(thread.posts).toEqual(["Preview is ready."]);
  });
});
