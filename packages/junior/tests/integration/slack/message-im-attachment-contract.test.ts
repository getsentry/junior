import { createTestDestination } from "../../fixtures/slack-harness";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { mswServer } from "../../msw/server";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000000.000001";
const ORIGINAL_ENV = { ...process.env };
const slackWebhookClient = createSlackWebhookTestClient({
  signingSecret: SIGNING_SECRET,
});

function makeDiagnostics() {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
  };
}

async function createDirectMessageBot(args: {
  completeText: () => Promise<{ text: string; message: never }>;
  agentRunner: AgentRunner;
}) {
  const [{ createSlackRuntime }, { JuniorChat }, { createJuniorSlackAdapter }] =
    await Promise.all([
      import("@/chat/app/factory"),
      import("@/chat/ingress/junior-chat"),
      import("@/chat/slack/adapter"),
    ]);
  const bot = new JuniorChat({
    userName: "junior",
    adapters: {
      slack: createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: BOT_USER_ID,
        signingSecret: SIGNING_SECRET,
      }),
    },
    state: createMemoryState(),
  });
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack"),
    services: {
      visionContext: {
        completeText: args.completeText,
      },
      replyExecutor: {
        agentRunner: args.agentRunner,
      },
    },
  });

  bot.onDirectMessage((thread, message) =>
    slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    }),
  );

  return bot;
}

describe("Slack contract: message.im attachment ingress", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_VISION_MODEL: "openai/gpt-5.4",
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("preserves DM file_share image attachments through the webhook and adapter path", async () => {
    mswServer.use(
      http.get("https://files.slack.com/private/current.png", async () => {
        return new HttpResponse(Buffer.from("image-bytes"), {
          headers: {
            "content-type": "image/png",
          },
        });
      }),
    );

    const capturedAttachmentMediaTypes: string[][] = [];
    const capturedAttachmentNames: string[][] = [];
    const bot = await createDirectMessageBot({
      completeText: async () => ({
        text: "Screenshot shows the current incident chart.",
        message: {} as never,
      }),
      agentRunner: {
        run: async (request) => {
          const _prompt = request.input.messageText;
          const context = {
            ...flattenAgentRunRequestForTest(request),
          };

          const attachments = context?.userAttachments ?? [];
          capturedAttachmentMediaTypes.push(
            attachments.map((attachment) => attachment.mediaType),
          );
          capturedAttachmentNames.push(
            attachments.map((attachment) => attachment.filename ?? ""),
          );
          return completedAgentRun({
            text: "Processed screenshot.",
            diagnostics: makeDiagnostics(),
          });
        },
      },
    });
    const waitUntil = slackWebhookClient.waitUntil();

    const baseEnvelope = slackEventsApiEnvelope({
      eventType: "message",
      channel: DM_CHANNEL_ID,
      ts: "1700000100.000100",
      threadTs: DM_THREAD_TS,
      text: "what is in this screenshot?",
    });
    const payload = {
      ...baseEnvelope,
      event: {
        ...baseEnvelope.event,
        subtype: "file_share",
        files: [
          {
            id: "F_CURRENT",
            mimetype: "image/png",
            name: "current.png",
            size: 11,
            url_private: "https://files.slack.com/private/current.png",
          },
        ],
      },
    };

    const { handleChatSdkPlatformWebhook } =
      await import("@/handlers/webhooks");
    const response = await handleChatSdkPlatformWebhook(
      slackWebhookClient.event(payload),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(capturedAttachmentMediaTypes).toEqual([["image/png"]]);
    expect(capturedAttachmentNames).toEqual([["current.png"]]);
  }, 20_000);
});
