import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message } from "chat";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";

function signSlackBody(body: string, timestamp: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

function createSlackRequest(body: string, signature?: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      ...(signature ? { "x-slack-signature": signature } : {}),
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

describe("Slack behavior: message_changed webhook ingress", () => {
  it("processes an edited DM mention after the original DM was already delivered", async () => {
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
    const handledMessages: Array<
      Pick<Message, "id" | "text" | "isMention" | "raw">
    > = [];
    const waitUntilTasks: Array<Promise<unknown>> = [];

    bot.onDirectMessage(async (_thread, message) => {
      handledMessages.push({
        id: message.id,
        text: message.text,
        isMention: message.isMention,
        raw: message.raw,
      });
    });

    const originalBody = JSON.stringify(
      slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000100",
        text: "hello there",
      }),
    );
    const originalTimestamp = String(Math.floor(Date.now() / 1000));
    const originalRequest = new Request(
      "https://example.test/api/webhooks/slack",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": originalTimestamp,
          "x-slack-signature": signSlackBody(originalBody, originalTimestamp),
        },
        body: originalBody,
      },
    );

    const originalResponse = await handlePlatformWebhook(
      originalRequest,
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    const editedPayload = {
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000100",
        text: "hello there",
      }),
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "D12345",
        hidden: true,
        message: {
          type: "message",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello there`,
          ts: "1700000100.000100",
        },
        previous_message: {
          type: "message",
          user: "U123",
          text: "hello there",
          ts: "1700000100.000100",
        },
      },
    };
    const editedBody = JSON.stringify(editedPayload);
    const editedTimestamp = String(Math.floor(Date.now() / 1000));
    const editedRequest = new Request(
      "https://example.test/api/webhooks/slack",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": editedTimestamp,
          "x-slack-signature": signSlackBody(editedBody, editedTimestamp),
        },
        body: editedBody,
      },
    );

    const editedResponse = await handlePlatformWebhook(
      editedRequest,
      "slack",
      collectWaitUntil(waitUntilTasks),
      bot,
    );
    await flushWaitUntil(waitUntilTasks);

    expect(originalResponse.status).toBe(200);
    expect(editedResponse.status).toBe(200);
    expect(handledMessages).toHaveLength(2);
    expect(handledMessages[0]).toMatchObject({
      id: "1700000100.000100",
      text: "hello there",
      isMention: false,
    });
    expect(handledMessages[1]).toMatchObject({
      id: "1700000100.000100:message_changed_mention",
      text: `<@${BOT_USER_ID}> hello there`,
      isMention: true,
    });
    const editedMessage = handledMessages[1];
    expect(editedMessage).toBeDefined();
    if (!editedMessage) {
      throw new Error("expected edited message to be handled");
    }
    expect((editedMessage.raw as { ts?: string }).ts).toBe("1700000100.000100");
  });

  it("streams an edited DM mention with the Slack recipient team metadata", async () => {
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
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Hello world");
            return {
              text: "Hello world",
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    bot.onDirectMessage((thread, message) =>
      slackRuntime.handleNewMention(thread, message),
    );

    const editedBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000100",
        text: "hello there",
      }),
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "D12345",
        hidden: true,
        message: {
          type: "message",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello there`,
          ts: "1700000100.000100",
        },
        previous_message: {
          type: "message",
          user: "U123",
          text: "hello there",
          ts: "1700000100.000100",
        },
      },
    });
    const editedTimestamp = String(Math.floor(Date.now() / 1000));
    const editedRequest = new Request(
      "https://example.test/api/webhooks/slack",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": editedTimestamp,
          "x-slack-signature": signSlackBody(editedBody, editedTimestamp),
        },
        body: editedBody,
      },
    );

    const response = await handlePlatformWebhook(
      editedRequest,
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

  it("flushes appendStream before stopStream for multi-chunk edited DM replies", async () => {
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
    const firstChunk = `${"A".repeat(96)}\n`;
    const secondChunk = `${"B".repeat(96)}\n`;
    const slackRuntime = createSlackRuntime({
      getSlackAdapter: () => bot.getAdapter("slack"),
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.(firstChunk);
            await context?.onTextDelta?.(secondChunk);
            return {
              text: `${firstChunk}${secondChunk}`.trimEnd(),
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });
    const waitUntilTasks: Array<Promise<unknown>> = [];

    bot.onDirectMessage((thread, message) =>
      slackRuntime.handleNewMention(thread, message),
    );

    const editedBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000101",
        text: "hello there",
      }),
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "D12345",
        hidden: true,
        message: {
          type: "message",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello there`,
          ts: "1700000100.000101",
        },
        previous_message: {
          type: "message",
          user: "U123",
          text: "hello there",
          ts: "1700000100.000101",
        },
      },
    });
    const editedTimestamp = String(Math.floor(Date.now() / 1000));
    const editedRequest = new Request(
      "https://example.test/api/webhooks/slack",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": editedTimestamp,
          "x-slack-signature": signSlackBody(editedBody, editedTimestamp),
        },
        body: editedBody,
      },
    );

    const response = await handlePlatformWebhook(
      editedRequest,
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
              text: firstChunk,
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
              text: secondChunk,
            },
          ],
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.stopStream")).toHaveLength(1);
  });

  it("rejects forged edited mentions before any bot handler runs", async () => {
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
    const handledMessages: Message[] = [];

    bot.onDirectMessage(async (_thread, message) => {
      handledMessages.push(message);
    });

    const body = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000100",
        text: "hello there",
      }),
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "D12345",
        message: {
          text: `<@${BOT_USER_ID}> hello there`,
          ts: "1700000100.000100",
          user: "U123",
        },
        previous_message: {
          text: "hello there",
        },
      },
    });
    const request = createSlackRequest(body, "v0=forged");

    const response = await handlePlatformWebhook(
      request,
      "slack",
      () => undefined,
      bot,
    );

    expect(response.status).toBe(401);
    expect(handledMessages).toHaveLength(0);
  });
});
