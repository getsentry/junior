import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanvas } from "@/chat/tools/slack/canvases";
import {
  canvasesAccessSetOk,
  canvasesCreateOk,
  filesInfoOk,
} from "../../fixtures/slack/factories/api";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";

describe("Slack behavior: assistant context canvas routing", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  afterEach(() => {});

  it("uses shared assistant context channel for canvas access grant when mention arrives in a DM", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_SHARED_CANVAS" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_SHARED_CANVAS",
        permalink: "https://example.invalid/files/F_SHARED_CANVAS",
      }),
    });

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await createCanvas({
              title: "Shared update",
              markdown: "Context-aware update",
              channelId: context?.toolChannelId,
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
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:D_DM_THREAD:1700007100.000",
      state: {
        artifacts: {
          assistantContextChannelId: "C_SHARED_CONTEXT",
        },
      },
    });
    const message = createTestMessage({
      id: "m-assistant-context-canvas-1",
      text: "<@U_APP> publish this as a shared canvas",
      isMention: true,
      threadId: thread.id,
      author: { userId: "U_TESTER" },
    });

    await slackRuntime.handleNewMention(thread, message);

    const canvasCreateCalls = getCapturedSlackApiCalls("canvases.create");
    expect(canvasCreateCalls).toHaveLength(1);
    expect(canvasCreateCalls[0]?.params).toMatchObject({
      title: "Shared update",
      document_content: {
        type: "markdown",
        markdown: "Context-aware update",
      },
    });
    expect(canvasCreateCalls[0]?.params).not.toHaveProperty("channel_id");

    const accessCalls = getCapturedSlackApiCalls("canvases.access.set");
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]?.params).toMatchObject({
      canvas_id: "F_SHARED_CANVAS",
      access_level: "write",
      channel_ids: ["C_SHARED_CONTEXT"],
    });

    expect(
      getCapturedSlackApiCalls("conversations.canvases.create"),
    ).toHaveLength(0);
  });
});
