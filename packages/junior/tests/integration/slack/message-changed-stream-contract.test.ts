import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";

function signSlackBody(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
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

function createEditedMentionRequest(args: {
  messageTs: string;
  newText: string;
  prevText: string;
}): Request {
  const body = JSON.stringify({
    ...slackEventsApiEnvelope({
      eventType: "message",
      channel: "D12345",
      ts: args.messageTs,
      text: args.prevText,
    }),
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "D12345",
      hidden: true,
      message: {
        type: "message",
        user: "U123",
        text: args.newText,
        ts: args.messageTs,
      },
      previous_message: {
        type: "message",
        user: "U123",
        text: args.prevText,
        ts: args.messageTs,
      },
    },
  });
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

async function createEditedDmStreamingBot(args: {
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
}) {
  const state = createMemoryState();
  await state.connect();
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
    userName: "junior",
    adapters: {
      slack: createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: BOT_USER_ID,
        signingSecret: SIGNING_SECRET,
      }),
    },
    state,
  });
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack"),
    services: {
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

describe("Slack contract: edited-message streaming", () => {
  it("includes recipient metadata on the first edited-DM stream request", async () => {
    const bot = await createEditedDmStreamingBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onTextDelta?.("Hello world");
        return {
          text: "Hello world",
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createEditedMentionRequest({
        messageTs: "1700000100.000100",
        newText: `<@${BOT_USER_ID}> hello there`,
        prevText: "hello there",
      }),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.startStream")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          thread_ts: "1700000100.000100",
          recipient_user_id: "U123",
          recipient_team_id: "T_TEST",
          chunks: [
            {
              type: "markdown_text",
              text: "Hello world",
            },
          ],
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.stopStream")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          chunks: [],
        }),
      }),
    ]);
  });

  it("finalizes an edited-DM stream after appended content is sent", async () => {
    const firstChunk = `${"A".repeat(96)}\n`;
    const secondChunk = `${"B".repeat(96)}\n`;
    const thirdChunk = `${"C".repeat(96)}\n`;
    const bot = await createEditedDmStreamingBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onTextDelta?.(firstChunk);
        await context?.onTextDelta?.(secondChunk);
        await context?.onTextDelta?.(thirdChunk);
        return {
          text: `${firstChunk}${secondChunk}${thirdChunk}`.trimEnd(),
          diagnostics: makeDiagnostics(),
        };
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    const response = await handlePlatformWebhook(
      createEditedMentionRequest({
        messageTs: "1700000100.000101",
        newText: `<@${BOT_USER_ID}> hello there`,
        prevText: "hello there",
      }),
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("chat.startStream")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          thread_ts: "1700000100.000101",
          chunks: [
            {
              type: "markdown_text",
              text: `${firstChunk}${secondChunk}`,
            },
          ],
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.appendStream")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          chunks: [
            {
              type: "markdown_text",
              text: thirdChunk,
            },
          ],
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.stopStream")).toHaveLength(1);
  });
});
