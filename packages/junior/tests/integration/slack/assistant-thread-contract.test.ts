import { createTestDestination } from "../../fixtures/slack-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { resetConversationTitleStateForTests } from "@/chat/services/conversation-title";
import { handleChatSdkPlatformWebhook } from "@/handlers/webhooks";
import { resetAssistantTitleProjectionForTests } from "@/chat/slack/assistant-thread/title";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModelAgentRunner } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../msw/server";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT";
const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000000.000001";
const CHANNEL_ID = "C12345";
const CHANNEL_ROOT_TS = "1700000200.000200";
const ORIGINAL_AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;
const slackWebhookClient = createSlackWebhookTestClient({
  signingSecret: SIGNING_SECRET,
});

function createDirectMessageRequest(
  text: string,
  options?: { threadTs?: string },
): Request {
  return slackWebhookClient.event(
    slackEventsApiEnvelope({
      eventType: "message",
      channel: DM_CHANNEL_ID,
      ts: "1700000100.000100",
      text,
      ...(options?.threadTs ? { threadTs: options.threadTs } : {}),
    }),
  );
}

function createChannelMentionRequest(
  text: string,
  options?: { threadTs?: string; ts?: string },
): Request {
  return slackWebhookClient.event(
    slackEventsApiEnvelope({
      eventType: "app_mention",
      channel: CHANNEL_ID,
      ts: options?.ts ?? CHANNEL_ROOT_TS,
      text,
      ...(options?.threadTs ? { threadTs: options.threadTs } : {}),
    }),
  );
}

function mockTurnRouterModel(): void {
  mswServer.use(
    http.post("https://ai-gateway.vercel.sh/v3/ai/language-model", () =>
      HttpResponse.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reasoning_level: "medium",
              profile: "standard",
              confidence: 0.9,
              reason: "Representative integration test request",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    ),
  );
}

function mockTitleModel(text: string, waitFor?: Promise<unknown>): void {
  mswServer.use(
    http.post("https://ai-gateway.vercel.sh/v1/messages", async () => {
      await waitFor;
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_title_fixture",
            type: "message",
            role: "assistant",
            model: "title-fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      const body = events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      return HttpResponse.text(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

function progressThenReply(): StreamFn {
  return createModelStream([
    {
      type: "toolCall",
      name: "reportProgress",
      arguments: { message: "Running bash" },
    },
    { type: "text", text: "Done." },
  ]);
}

async function createDirectMessageBot(modelStream: StreamFn) {
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
    userName: "junior",
    adapters: {
      slack: createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: BOT_USER_ID,
        signingSecret: SIGNING_SECRET,
      }),
    },
    state: getStateAdapter(),
  });
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack"),
    services: {
      replyExecutor: {
        agentRunner: createModelAgentRunner(modelStream),
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

async function createMentionBot(modelStream: StreamFn) {
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
    userName: "junior",
    adapters: {
      slack: createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: BOT_USER_ID,
        signingSecret: SIGNING_SECRET,
      }),
    },
    state: getStateAdapter(),
  });
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack"),
    services: {
      replyExecutor: {
        agentRunner: createModelAgentRunner(modelStream),
      },
    },
  });

  bot.onNewMention((thread, message) =>
    slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    }),
  );

  return bot;
}

describe("Slack contract: assistant-thread delivery", () => {
  beforeEach(async () => {
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
    mockTurnRouterModel();
    mockTitleModel("Run a command");
    resetSlackApiMockState();
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    // Chat and Junior scratch must share one adapter; clear between cases so
    // fixed DM thread ids do not inherit prior title/artifact scratch.
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    if (ORIGINAL_AI_GATEWAY_API_KEY === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = ORIGINAL_AI_GATEWAY_API_KEY;
    }
    resetSlackApiMockState();
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("does not post assistant status when the DM message omits thread_ts", async () => {
    const bot = await createDirectMessageBot(progressThenReply());
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createDirectMessageRequest("run a command"),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(slackApiOutbox.calls("assistant.threads.setStatus")).toEqual([]);
  });

  it("posts assistant status with a raw DM channel id when thread_ts is present", async () => {
    const bot = await createDirectMessageBot(progressThenReply());
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createDirectMessageRequest("run a command", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(slackApiOutbox.calls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: DM_THREAD_TS,
            status: expect.any(String),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: DM_THREAD_TS,
            status: "",
          }),
        }),
      ]),
    );
  });

  it("posts assistant status for the first channel-thread reply before Slack adds thread_ts", async () => {
    const bot = await createMentionBot(progressThenReply());
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createChannelMentionRequest("<@U0BOT> run a command"),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(slackApiOutbox.calls("assistant.threads.setStatus")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: CHANNEL_ID,
            thread_ts: CHANNEL_ROOT_TS,
            status: expect.any(String),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: CHANNEL_ID,
            thread_ts: CHANNEL_ROOT_TS,
            status: "",
          }),
        }),
      ]),
    );
  });

  it("posts assistant titles with a raw DM channel id when thread_ts is present", async () => {
    mockTitleModel("Debugging Node.js Memory Leaks");
    const bot = await createDirectMessageBot(
      createModelStream([
        { type: "text", text: "Here is how to debug memory leaks." },
      ]),
    );
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(slackApiOutbox.calls("assistant.threads.setTitle")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: DM_THREAD_TS,
          title: "Debugging Node.js Memory Leaks",
        }),
      }),
    ]);
  });

  it("lets the awaited webhook turn task finish before slow title generation", async () => {
    let resolveTitle: (() => void) | undefined;
    const titleGate = new Promise<void>((resolve) => {
      resolveTitle = resolve;
    });
    mockTitleModel("Debugging Node.js Memory Leaks", titleGate);
    const bot = await createDirectMessageBot(
      createModelStream([
        { type: "text", text: "Here is how to debug memory leaks." },
      ]),
    );
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();
    expect(slackApiOutbox.calls("assistant.threads.setTitle")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: DM_THREAD_TS,
            title: "Debugging Node.js Memory Leaks",
          }),
        }),
      ]),
    );

    resetSlackApiMockState();
    resolveTitle!();
    await vi.waitFor(() => {
      expect(slackApiOutbox.calls("assistant.threads.setTitle")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            channel_id: DM_CHANNEL_ID,
            thread_ts: DM_THREAD_TS,
            title: "Debugging Node.js Memory Leaks",
          }),
        }),
      ]);
    });
  });

  it("does not post assistant titles when the DM message omits thread_ts", async () => {
    mockTitleModel("Debugging Node.js Memory Leaks");
    const bot = await createDirectMessageBot(
      createModelStream([
        { type: "text", text: "Here is how to debug memory leaks." },
      ]),
    );
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?"),
      "slack",
      waitUntil.fn,
      bot,
    );

    expect(response.status).toBe(200);
    await waitUntil.flush();

    expect(slackApiOutbox.calls("assistant.threads.setTitle")).toEqual([]);
  });
});
