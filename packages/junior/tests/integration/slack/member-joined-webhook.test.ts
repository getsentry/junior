import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { closeDb, getConversationStore } from "@/chat/db";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { conversationsInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const SIGNING_SECRET = "test-signing-secret";
const ORIGINAL_ENV = { ...process.env };

async function deliverMemberJoined(args: { channel: string; user: string }) {
  const client = createSlackWebhookTestClient({
    signingSecret: SIGNING_SECRET,
  });
  const waitUntil = client.waitUntil();
  const response = await handleSlackWebhook({
    request: client.event({
      team_id: "T123",
      type: "event_callback",
      event: {
        type: "member_joined_channel",
        user: args.user,
        channel: args.channel,
        channel_type: "C",
        team: "T123",
        event_ts: "1712345.0001",
      },
    }),
    waitUntil: waitUntil.fn,
    services: {
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

async function storedVisibility(channelId: string) {
  return await getConversationStore().getDestinationVisibility({
    provider: "slack",
    providerTenantId: "T123",
    providerDestinationId: channelId,
  });
}

describe("Slack webhook: member_joined_channel", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
    await closeDb();
  });

  it("stores the visibility of a public channel that Junior joins", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({ channelId: "C0JOINED", isPrivate: false }),
    });

    const response = await deliverMemberJoined({
      channel: "C0JOINED",
      user: "U0BOT",
    });

    expect(response.status).toBe(200);
    expect(await storedVisibility("C0JOINED")).toBe("public");
  });

  it("stores the visibility of a private channel that Junior joins", async () => {
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({ channelId: "C0SECRET", isPrivate: true }),
    });

    await deliverMemberJoined({ channel: "C0SECRET", user: "U0BOT" });

    expect(await storedVisibility("C0SECRET")).toBe("private");
  });

  it("ignores another member joining", async () => {
    const response = await deliverMemberJoined({
      channel: "C0OTHER",
      user: "U0PERSON",
    });

    expect(response.status).toBe(200);
    expect(getCapturedSlackApiCalls("conversations.info")).toEqual([]);
    expect(await storedVisibility("C0OTHER")).toBeUndefined();
  });
});
