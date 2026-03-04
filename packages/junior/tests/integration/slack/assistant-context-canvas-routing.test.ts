import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSlackRuntime, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { createCanvas } from "@/chat/slack-actions/canvases";
import { conversationsCanvasesCreateOk, filesInfoOk } from "../../fixtures/slack/factories/api";
import { createTestMessage, createTestThread } from "../../fixtures/slack-harness";
import { getCapturedSlackApiCalls, queueSlackApiResponse } from "../../msw/handlers/slack-api";

describe("Slack behavior: assistant context canvas routing", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  afterEach(() => {
    resetBotDepsForTests();
  });

  it("uses shared assistant context channel for canvas creation when mention arrives in a DM", async () => {
    queueSlackApiResponse("conversations.canvases.create", {
      body: conversationsCanvasesCreateOk({ canvasId: "F_SHARED_CANVAS" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_SHARED_CANVAS",
        permalink: "https://example.invalid/files/F_SHARED_CANVAS"
      })
    });

    setBotDepsForTests({
      generateAssistantReply: async (_prompt, context) => {
        await createCanvas({
          title: "Shared update",
          markdown: "Context-aware update",
          channelId: context?.toolChannelId
        });
        return {
          text: "Shared canvas created.",
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
      id: "slack:D_DM_THREAD:1700007100.000",
      state: {
        artifacts: {
          assistantContextChannelId: "C_SHARED_CONTEXT"
        }
      }
    });
    const message = createTestMessage({
      id: "m-assistant-context-canvas-1",
      text: "<@U_APP> publish this as a shared canvas",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" }
    });

    await appSlackRuntime.handleNewMention(thread, message);

    const conversationScopedCalls = getCapturedSlackApiCalls("conversations.canvases.create");
    expect(conversationScopedCalls).toHaveLength(1);
    expect(conversationScopedCalls[0]?.params).toMatchObject({
      channel_id: "C_SHARED_CONTEXT",
      title: "Shared update",
      document_content: {
        type: "markdown",
        markdown: "Context-aware update"
      }
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(0);
  });
});
