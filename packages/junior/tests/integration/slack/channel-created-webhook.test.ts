import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const SIGNING_SECRET = "test-signing-secret";
const ORIGINAL_ENV = { ...process.env };

async function deliverChannelCreated(autoJoinNewChannels: boolean) {
  const client = createSlackWebhookTestClient({
    signingSecret: SIGNING_SECRET,
  });
  const waitUntil = client.waitUntil();
  const response = await handleSlackWebhook({
    request: client.event({
      team_id: "T123",
      type: "event_callback",
      event: {
        type: "channel_created",
        channel: {
          id: "C0NEW",
          name: "proj-new",
          created: 1712345,
          creator: "U123",
        },
        event_ts: "1712345.0001",
      },
    }),
    waitUntil: waitUntil.fn,
    services: {
      autoJoinNewChannels,
      getSlackAdapter: () =>
        createJuniorSlackAdapter({
          botToken: "xoxb-test-token",
          botUserId: "U0BOT",
          signingSecret: SIGNING_SECRET,
        }),
      queue: createConversationWorkQueueTestAdapter(),
      runtime: createNoopSlackWebhookRuntime(),
      state: createMemoryState(),
    },
  });
  await waitUntil.flush();
  return response;
}

describe("Slack webhook: channel_created", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("joins the new public channel when auto-join is on", async () => {
    const response = await deliverChannelCreated(true);

    expect(response.status).toBe(200);
    expect(
      getCapturedSlackApiCalls("conversations.join").map(
        (call) => call.params.channel,
      ),
    ).toEqual(["C0NEW"]);
  });

  it("acknowledges without joining when auto-join is off", async () => {
    const response = await deliverChannelCreated(false);

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("conversations.join")).toEqual([]);
  });
});
