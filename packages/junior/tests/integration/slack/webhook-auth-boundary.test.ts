import { describe, expect, it } from "vitest";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const SIGNING_SECRET = "test-signing-secret";

describe("Slack webhook auth boundary", () => {
  it("rejects invalid Slack signatures before durable state is required", async () => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const adapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: client.invalidSignature({ type: "event_callback" }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
  });
});
