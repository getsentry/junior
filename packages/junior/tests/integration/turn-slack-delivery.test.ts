import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/chat/db";
import { DeliveryRetryableError } from "@/delivery/deliver";
import { createDeploymentDelivery } from "@/turn-steps/turn-ended";
import { createSlackAdapterFixture } from "../fixtures/conversation-work";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

// The deployment's Delivery of core Turn replies, against the fake Slack API.

const CONVERSATION_ID = "slack:C123:1700000000.000100";
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
  threadTs: "1700000000.000100",
} as const;

function delivery() {
  return createDeploymentDelivery({
    getSlackAdapter: createSlackAdapterFixture,
  });
}

describe("deployment Delivery", () => {
  beforeEach(() => {
    resetSlackApiMockState();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    await closeDb();
  });

  it("posts a reply to its Slack thread", async () => {
    const sent = await delivery().send({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      text: "Three.",
    });

    const posts = getCapturedSlackApiCalls("chat.postMessage");
    expect(posts).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
        }),
      }),
    ]);
    expect(posts[0]?.params["text"]).toContain("Three.");
    // A reply in an existing thread starts no thread.
    expect(sent).toEqual({ providerMessageId: expect.any(String) });
  });

  it("fails a send that Slack can take later as retryable", async () => {
    queueSlackApiError("chat.postMessage", { error: "service_unavailable" });

    await expect(
      delivery().send({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        text: "Three.",
      }),
    ).rejects.toBeInstanceOf(DeliveryRetryableError);
  });

  it("fails a send that Slack rejects as not retryable", async () => {
    queueSlackApiError("chat.postMessage", { error: "channel_not_found" });

    const send = delivery().send({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      text: "Three.",
    });

    await expect(send).rejects.toThrow(/channel_not_found/);
    await expect(send).rejects.not.toBeInstanceOf(DeliveryRetryableError);
  });

  it("fails a reply to a Destination that has no sender", async () => {
    await expect(
      delivery().send({
        conversationId: "local:1",
        destination: { platform: "local", conversationId: "local:1" },
        text: "Three.",
      }),
    ).rejects.toThrow("No sender for local Destinations");
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });
});
