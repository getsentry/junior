import { describe, expect, it } from "vitest";
import { deliverPrivateMessage } from "@/chat/oauth-flow";
import {
  TEST_CHANNEL_ID,
  TEST_DM_CHANNEL_ID,
  TEST_THREAD_TS,
  TEST_USER_ID,
} from "../fixtures/slack/factories/ids";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
} from "../msw/handlers/slack-api";

describe("OAuth private Slack delivery", () => {
  it("delivers a channel authorization link ephemerally", async () => {
    const result = await deliverPrivateMessage({
      channelId: TEST_CHANNEL_ID,
      threadTs: TEST_THREAD_TS,
      userId: TEST_USER_ID,
      text: "Authorize privately",
    });

    expect(result).toBe("in_context");
    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          thread_ts: TEST_THREAD_TS,
          user: TEST_USER_ID,
          text: "Authorize privately",
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("conversations.open")).toEqual([]);
  });

  it("delivers a direct-message authorization link in the existing DM", async () => {
    const result = await deliverPrivateMessage({
      channelId: TEST_DM_CHANNEL_ID,
      threadTs: TEST_THREAD_TS,
      userId: TEST_USER_ID,
      text: "Authorize privately",
    });

    expect(result).toBe("in_context");
    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([]);
    expect(getCapturedSlackApiCalls("conversations.open")).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: TEST_DM_CHANNEL_ID,
          thread_ts: TEST_THREAD_TS,
          text: "Authorize privately",
        }),
      }),
    ]);
  });

  it("falls back to a direct message when ephemeral delivery fails", async () => {
    queueSlackApiError("chat.postEphemeral", {
      error: "channel_not_found",
    });

    const result = await deliverPrivateMessage({
      channelId: TEST_CHANNEL_ID,
      threadTs: TEST_THREAD_TS,
      userId: TEST_USER_ID,
      text: "Authorize privately",
    });

    expect(result).toBe("fallback_dm");
    expect(getCapturedSlackApiCalls("conversations.open")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ users: TEST_USER_ID }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: TEST_DM_CHANNEL_ID,
          text: "Authorize privately",
        }),
      }),
    ]);
  });
});
