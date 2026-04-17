import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { ConversationMemoryDeps } from "@/chat/services/conversation-memory";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000000.000001";
const CHANNEL_ID = "C12345";
const CHANNEL_ROOT_TS = "1700000200.000200";

function signSlackBody(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function createDirectMessageRequest(
  text: string,
  options?: { threadTs?: string },
): Request {
  const body = JSON.stringify(
    slackEventsApiEnvelope({
      eventType: "message",
      channel: DM_CHANNEL_ID,
      ts: "1700000100.000100",
      text,
      ...(options?.threadTs ? { threadTs: options.threadTs } : {}),
    }),
  );
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

function createChannelMentionRequest(
  text: string,
  options?: { threadTs?: string; ts?: string },
): Request {
  const body = JSON.stringify(
    slackEventsApiEnvelope({
      eventType: "app_mention",
      channel: CHANNEL_ID,
      ts: options?.ts ?? CHANNEL_ROOT_TS,
      text,
      ...(options?.threadTs ? { threadTs: options.threadTs } : {}),
    }),
  );
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

async function flushWaitUntil(tasks: Array<Promise<unknown>>): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

function collectWaitUntil(tasks: Array<Promise<unknown>>): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
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
  completeText?: ConversationMemoryDeps["completeText"];
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
}) {
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
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
      ...(args.completeText
        ? {
            conversationMemory: {
              completeText:
                args.completeText as ConversationMemoryDeps["completeText"],
            },
          }
        : {}),
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

async function createMentionBot(args: {
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
}) {
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
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
      replyExecutor: {
        generateAssistantReply: args.generateAssistantReply,
      },
    },
  });

  bot.onNewMention((thread, message) =>
    slackRuntime.handleNewMention(thread, message),
  );

  return bot;
}

describe("Slack contract: assistant-thread delivery", () => {
  beforeEach(() => {
    resetSlackApiMockState();
  });

  afterEach(() => {
    resetSlackApiMockState();
  });

  it("does not post assistant status when the DM message omits thread_ts", async () => {
    const bot = await createDirectMessageBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onStatus?.(makeAssistantStatus("running", "bash"));
        return {
          text: "Done.",
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createDirectMessageRequest("run a command"),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([]);
  });

  it("posts assistant status with a raw DM channel id when thread_ts is present", async () => {
    const bot = await createDirectMessageBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onStatus?.(makeAssistantStatus("running", "bash"));
        return {
          text: "Done.",
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createDirectMessageRequest("run a command", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual(
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
    const bot = await createMentionBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onStatus?.(makeAssistantStatus("running", "bash"));
        return {
          text: "Done.",
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createChannelMentionRequest("<@U_BOT> run a command"),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual(
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
    const bot = await createDirectMessageBot({
      completeText: async () =>
        ({
          text: "Debugging Node.js Memory Leaks",
          message: { role: "assistant", content: "" },
        }) as any,
      generateAssistantReply: async () => ({
        text: "Here is how to debug memory leaks.",
        diagnostics: makeDiagnostics(),
      }),
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCapturedSlackApiCalls("assistant.threads.setTitle")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: DM_THREAD_TS,
          title: "Debugging Node.js Memory Leaks",
        }),
      }),
    ]);
  });

  it("keeps title generation inside the awaited webhook turn task", async () => {
    const bot = await createDirectMessageBot({
      completeText: async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: "Debugging Node.js Memory Leaks",
                message: { role: "assistant", content: "" },
              } as any),
            10,
          ),
        ),
      generateAssistantReply: async () => ({
        text: "Here is how to debug memory leaks.",
        diagnostics: makeDiagnostics(),
      }),
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?", {
        threadTs: DM_THREAD_TS,
      }),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);

    expect(getCapturedSlackApiCalls("assistant.threads.setTitle")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: DM_THREAD_TS,
          title: "Debugging Node.js Memory Leaks",
        }),
      }),
    ]);
  });

  it("does not post assistant titles when the DM message omits thread_ts", async () => {
    const bot = await createDirectMessageBot({
      completeText: async () =>
        ({
          text: "Debugging Node.js Memory Leaks",
          message: { role: "assistant", content: "" },
        }) as any,
      generateAssistantReply: async () => ({
        text: "Here is how to debug memory leaks.",
        diagnostics: makeDiagnostics(),
      }),
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createDirectMessageRequest("How do I debug memory leaks in Node?"),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(waitUntilTasks);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCapturedSlackApiCalls("assistant.threads.setTitle")).toEqual([]);
  });
});
