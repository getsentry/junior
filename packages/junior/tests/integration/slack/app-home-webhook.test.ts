import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter } from "@/chat/state/adapter";
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
      waitUntil: () => {},
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
    expect(getCapturedSlackApiCalls("views.publish")).toHaveLength(1);
  });
});
