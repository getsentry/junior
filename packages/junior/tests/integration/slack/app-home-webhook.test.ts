import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { WaitUntilFn } from "@/handlers/types";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const ORIGINAL_ENV = { ...process.env };

function signSlackBody(body: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

function slackWebhookRequest(body: unknown): Request {
  const serialized = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(serialized, timestamp),
    },
    body: serialized,
  });
}

function slackFormRequest(params: URLSearchParams): Request {
  const serialized = params.toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(serialized, timestamp),
    },
    body: serialized,
  });
}

function interactiveDisconnectPayload(): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: {
      id: "U123",
      team_id: "T123",
      username: "alice",
    },
    actions: [
      {
        action_id: "app_home_disconnect",
        value: "notion",
      },
    ],
  };
}

function createTokenStore(
  overrides: Partial<UserTokenStore> = {},
): UserTokenStore {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

type WaitUntilTask = Promise<unknown>;

function collectWaitUntil(tasks: WaitUntilTask[]): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

async function flushWaitUntil(tasks: WaitUntilTask[]): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Slack webhook: App Home events", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("acknowledges app_home_opened when publishing the view fails", async () => {
    queueSlackApiError("views.publish", {
      error: "internal_error",
      status: 200,
    });

    const state = createMemoryState();
    const waitUntilTasks: WaitUntilTask[] = [];
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: BOT_USER_ID,
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: slackWebhookRequest({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_home_opened",
          user: "U123",
          event_ts: "1712345.0001",
        },
      }),
      waitUntil: collectWaitUntil(waitUntilTasks),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue: {
          send: async () => {
            throw new Error("app_home_opened should not enqueue work");
          },
        },
        runtime: {
          handleAssistantContextChanged: async () => {
            throw new Error("unexpected assistant context callback");
          },
          handleAssistantThreadStarted: async () => {
            throw new Error("unexpected assistant thread callback");
          },
          handleNewMention: async () => {
            throw new Error("unexpected mention callback");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed message callback");
          },
        },
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await flushWaitUntil(waitUntilTasks);
    expect(getCapturedSlackApiCalls("views.publish")).toHaveLength(1);
  });

  it("acknowledges message events before durable handoff work finishes", async () => {
    const state = createMemoryState();
    const waitUntilTasks: WaitUntilTask[] = [];
    const queueMessages: Array<{ conversationId: string }> = [];
    const queueSendEntered = deferred();
    const finishQueueSend = deferred();
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: BOT_USER_ID,
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: slackWebhookRequest({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_mention",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello`,
          channel: "C123",
          ts: "1712345.0001",
          event_ts: "1712345.0001",
          channel_type: "channel",
        },
      }),
      waitUntil: collectWaitUntil(waitUntilTasks),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue: {
          send: async (message) => {
            queueMessages.push(message);
            queueSendEntered.resolve();
            await finishQueueSend.promise;
            return { messageId: "queue-1" };
          },
        },
        runtime: {
          handleAssistantContextChanged: async () => {
            throw new Error("unexpected assistant context callback");
          },
          handleAssistantThreadStarted: async () => {
            throw new Error("unexpected assistant thread callback");
          },
          handleNewMention: async () => {
            throw new Error("unexpected mention callback");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed message callback");
          },
        },
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await queueSendEntered.promise;
    expect(queueMessages).toEqual([
      { conversationId: "slack:C123:1712345.0001" },
    ]);

    finishQueueSend.resolve();
    await flushWaitUntil(waitUntilTasks);
  });

  it("routes explicit mentions from other Slack bots", async () => {
    const state = createMemoryState();
    const waitUntilTasks: WaitUntilTask[] = [];
    const queueMessages: Array<{ conversationId: string }> = [];
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: BOT_USER_ID,
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: slackWebhookRequest({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "message",
          subtype: "bot_message",
          bot_id: "B_DEPLOY",
          username: "Deploy Bot",
          text: `<@${BOT_USER_ID}> production deploy failed`,
          channel: "C123",
          ts: "1712345.0002",
          event_ts: "1712345.0002",
          channel_type: "channel",
        },
      }),
      waitUntil: collectWaitUntil(waitUntilTasks),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue: {
          send: async (message) => {
            queueMessages.push(message);
            return { messageId: "queue-1" };
          },
        },
        runtime: {
          handleAssistantContextChanged: async () => {
            throw new Error("unexpected assistant context callback");
          },
          handleAssistantThreadStarted: async () => {
            throw new Error("unexpected assistant thread callback");
          },
          handleNewMention: async () => {
            throw new Error("unexpected mention callback");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed message callback");
          },
        },
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await flushWaitUntil(waitUntilTasks);
    expect(queueMessages).toEqual([
      { conversationId: "slack:C123:1712345.0002" },
    ]);
  });

  it("refreshes App Home after disconnect unlink failure", async () => {
    const state = createMemoryState();
    const waitUntilTasks: WaitUntilTask[] = [];
    const deleteToken = vi.fn(async () => {
      throw new Error("token store unavailable");
    });
    const userTokenStore = createTokenStore({ delete: deleteToken });
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: BOT_USER_ID,
      signingSecret: SIGNING_SECRET,
    });
    const params = new URLSearchParams({
      payload: JSON.stringify(interactiveDisconnectPayload()),
    });

    const response = await handleSlackWebhook({
      request: slackFormRequest(params),
      waitUntil: collectWaitUntil(waitUntilTasks),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue: {
          send: async () => {
            throw new Error("interactive disconnect should not enqueue work");
          },
        },
        runtime: {
          handleAssistantContextChanged: async () => {
            throw new Error("unexpected assistant context callback");
          },
          handleAssistantThreadStarted: async () => {
            throw new Error("unexpected assistant thread callback");
          },
          handleNewMention: async () => {
            throw new Error("unexpected mention callback");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed message callback");
          },
        },
        state,
        userTokenStore,
      },
    });

    expect(response.status).toBe(200);
    expect(waitUntilTasks).toHaveLength(1);
    await flushWaitUntil(waitUntilTasks);
    expect(deleteToken).toHaveBeenCalledWith("U123", "notion");
    expect(getCapturedSlackApiCalls("views.publish")).toHaveLength(1);
  });
});
