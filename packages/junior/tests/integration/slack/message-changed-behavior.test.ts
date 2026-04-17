import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message } from "chat";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { WaitUntilFn } from "@/handlers/types";
import { handlePlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const ORIGINAL_ENV = { ...process.env };

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
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

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

  it("preserves edited-message image attachments through to the agent context", async () => {
    mswServer.use(
      http.get("https://files.slack.com/private/edited.png", async () => {
        return new HttpResponse(Buffer.from("image-bytes"), {
          headers: {
            "content-type": "image/png",
          },
        });
      }),
    );

    const state = createMemoryState();
    await state.connect();
    const bot = new JuniorChat({
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
    const waitUntilTasks: Array<Promise<unknown>> = [];
    const handledMessages: Array<
      Pick<Message, "attachments" | "id" | "isMention" | "text">
    > = [];

    bot.onDirectMessage(async (_thread, message) => {
      handledMessages.push({
        id: message.id,
        text: message.text,
        isMention: message.isMention,
        attachments: message.attachments,
      });
    });

    const editedBody = JSON.stringify({
      ...slackEventsApiEnvelope({
        eventType: "message",
        channel: "D12345",
        ts: "1700000100.000102",
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
          text: `<@${BOT_USER_ID}> what is in this screenshot?`,
          ts: "1700000100.000102",
          files: [
            {
              id: "F_EDITED",
              mimetype: "image/png",
              name: "edited.png",
              size: 11,
              url_private: "https://files.slack.com/private/edited.png",
            },
          ],
        },
        previous_message: {
          type: "message",
          user: "U123",
          text: "what is in this screenshot?",
          ts: "1700000100.000102",
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
    expect(handledMessages).toHaveLength(1);
    const editedMessage = handledMessages[0];
    expect(editedMessage).toMatchObject({
      id: "1700000100.000102:message_changed_mention",
      text: `<@${BOT_USER_ID}> what is in this screenshot?`,
      isMention: true,
    });
    expect(editedMessage?.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        name: "edited.png",
        mimeType: "image/png",
        url: "https://files.slack.com/private/edited.png",
      }),
    ]);
    const imageData = await editedMessage?.attachments[0]?.fetchData?.();
    expect(imageData?.toString()).toBe("image-bytes");
  });

  it("posts a finalized reply back into the edited DM thread", async () => {
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
    const postCalls = getCapturedSlackApiCalls("chat.postMessage");

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          thread_ts: "1700000100.000100",
          text: "Hello world",
        }),
      }),
    );
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
