import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { mswServer } from "../../msw/server";
import type { WaitUntilFn } from "@/handlers/types";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000000.000001";
const ORIGINAL_ENV = { ...process.env };

function signSlackBody(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function createSlackRequest(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(body, timestamp),
    },
    body,
  });
}

function collectWaitUntil(tasks: Array<Promise<unknown>>): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

async function flushWaitUntil(tasks: Array<Promise<unknown>>): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

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
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
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
        generateAssistantReply: args.generateAssistantReply,
      },
    },
  });

  bot.onDirectMessage((thread, message) =>
    slackRuntime.handleNewMention(thread, message),
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
      generateAssistantReply: async (_prompt, context) => {
        const attachments = context?.userAttachments ?? [];
        capturedAttachmentMediaTypes.push(
          attachments.map((attachment) => attachment.mediaType),
        );
        capturedAttachmentNames.push(
          attachments.map((attachment) => attachment.filename ?? ""),
        );
        return {
          text: "Processed screenshot.",
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const baseEnvelope = slackEventsApiEnvelope({
      eventType: "message",
      channel: DM_CHANNEL_ID,
      ts: "1700000100.000100",
      threadTs: DM_THREAD_TS,
      text: "what is in this screenshot?",
    });
    const body = JSON.stringify({
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
    });

    const { handlePlatformWebhook } = await import("@/handlers/webhooks");
    const response = await handlePlatformWebhook(
      createSlackRequest(body),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);

    expect(capturedAttachmentMediaTypes).toEqual([["image/png"]]);
    expect(capturedAttachmentNames).toEqual([["current.png"]]);
  }, 10_000);
});
