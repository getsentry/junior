import { createTestDestination } from "../../fixtures/slack-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { ConversationMemoryDeps } from "@/chat/services/conversation-memory";
import { handleChatSdkPlatformWebhook } from "@/handlers/webhooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { flattenReplyRequestForTest } from "../../fixtures/agent-runner";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000000.000001";
const CHANNEL_ID = "C12345";
const CHANNEL_ROOT_TS = "1700000200.000200";
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

function makeCompletedReply(text: string) {
  return completedAgentRun({
    text,
    diagnostics: makeDiagnostics(),
  });
}

async function createDirectMessageBot(args: {
  completeText?: ConversationMemoryDeps["completeText"];
  agentRunner: AgentRunner;
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

async function createMentionBot(args: { agentRunner: AgentRunner }) {
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
        agentRunner: args.agentRunner,
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
  beforeEach(() => {
    resetSlackApiMockState();
  });

  afterEach(() => {
    resetSlackApiMockState();
  });

  it("does not post assistant status when the DM message omits thread_ts", async () => {
    const bot = await createDirectMessageBot({
      agentRunner: {
        run: async (request) => {
          const _prompt = request.input.messageText;
          const context = {
            ...flattenReplyRequestForTest(request),
          };

          await context?.onStatus?.(makeAssistantStatus("running", "bash"));
          return makeCompletedReply("Done.");
        },
      },
    });
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
    const bot = await createDirectMessageBot({
      agentRunner: {
        run: async (request) => {
          const _prompt = request.input.messageText;
          const context = {
            ...flattenReplyRequestForTest(request),
          };

          await context?.onStatus?.(makeAssistantStatus("running", "bash"));
          return makeCompletedReply("Done.");
        },
      },
    });
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
    const bot = await createMentionBot({
      agentRunner: {
        run: async (request) => {
          const _prompt = request.input.messageText;
          const context = {
            ...flattenReplyRequestForTest(request),
          };

          await context?.onStatus?.(makeAssistantStatus("running", "bash"));
          return makeCompletedReply("Done.");
        },
      },
    });
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createChannelMentionRequest("<@U_BOT> run a command"),
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
    const bot = await createDirectMessageBot({
      completeText: async () =>
        ({
          text: "Debugging Node.js Memory Leaks",
          message: { role: "assistant", content: "" },
        }) as any,
      agentRunner: {
        run: async () =>
          makeCompletedReply("Here is how to debug memory leaks."),
      },
    });
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
    const bot = await createDirectMessageBot({
      completeText: async () =>
        await new Promise((resolve) => {
          resolveTitle = () => {
            resolve({
              text: "Debugging Node.js Memory Leaks",
              message: { role: "assistant", content: "" },
            } as any);
          };
        }),
      agentRunner: {
        run: async () =>
          makeCompletedReply("Here is how to debug memory leaks."),
      },
    });
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
    const bot = await createDirectMessageBot({
      completeText: async () =>
        ({
          text: "Debugging Node.js Memory Leaks",
          message: { role: "assistant", content: "" },
        }) as any,
      agentRunner: {
        run: async () =>
          makeCompletedReply("Here is how to debug memory leaks."),
      },
    });
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
