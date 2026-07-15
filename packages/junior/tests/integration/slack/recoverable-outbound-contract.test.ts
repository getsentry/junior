import { beforeEach, describe, expect, it } from "vitest";
import {
  parseSlackDeliveryLocator,
  postRecoverableSlackMessage,
  reconcileRecoverableSlackMessage,
  type SlackDeliveryMetadata,
} from "@/chat/slack/outbound";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackRateLimit,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

const THREAD_TS = "1700000000.000100";
const OLDEST_TS = "1700000001.000100";
const DELIVERY_TS = "1700000002.000100";
const DEFAULT_POSTED_TS = "1700000000.100";

function deliveryMetadata(partIndex = 0): SlackDeliveryMetadata {
  const locator = parseSlackDeliveryLocator("abcdefghijklmnopqrstuv");
  if (!locator) throw new Error("Test delivery locator must be valid");
  return { locator, partIndex };
}

function recoveredMessage(
  input: {
    metadata?: Record<string, unknown>;
    botId?: string;
    userId?: string;
    ts?: string;
  } = {},
): Record<string, unknown> {
  return {
    ts: input.ts ?? DELIVERY_TS,
    thread_ts: THREAD_TS,
    text: "delivered text is unrelated to the marker",
    ...(input.botId === undefined ? { bot_id: "B_TEST_BOT" } : {}),
    ...(input.botId ? { bot_id: input.botId } : {}),
    ...(input.userId ? { user: input.userId } : {}),
    metadata: input.metadata ?? {
      event_type: "junior_delivery",
      event_payload: {
        locator: "abcdefghijklmnopqrstuv",
        part_index: 0,
      },
    },
  };
}

describe("Slack contract: recoverable outbound delivery", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    resetSlackApiMockState();
  });

  it("posts once with only the fixed public-safe delivery metadata", async () => {
    const result = await postRecoverableSlackMessage({
      channelId: "slack:C123",
      threadTs: THREAD_TS,
      text: "hello",
      metadata: deliveryMetadata(2),
    });

    expect(result).toEqual({ outcome: "accepted", ts: DEFAULT_POSTED_TS });
    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({
      channel: "C123",
      thread_ts: THREAD_TS,
      text: "hello",
      metadata: {
        event_type: "junior_delivery",
        event_payload: {
          locator: "abcdefghijklmnopqrstuv",
          part_index: 2,
        },
      },
    });
    expect(JSON.stringify(calls[0]?.params.metadata)).not.toMatch(
      /conversation|channel|thread|turn|message|text|authorization/i,
    );
  });

  it.each([
    ["Slack 5xx", { status: 503, body: "unavailable" }, "server_error"],
    ["connection reset", { networkError: true }, "transport_error"],
  ] as const)(
    "does not retry an ambiguous %s write",
    async (_label, response, reason) => {
      queueSlackApiResponse("chat.postMessage", response);
      const result = await postRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        text: "hello",
        metadata: deliveryMetadata(),
      });

      expect(result).toEqual({ outcome: "uncertain", reason });
      expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    },
  );

  it("classifies an explicit Slack rejection as definitive without retrying", async () => {
    queueSlackApiError("chat.postMessage", { error: "not_in_channel" });

    const result = await postRecoverableSlackMessage({
      channelId: "C123",
      text: "hello",
      metadata: deliveryMetadata(),
    });

    expect(result).toEqual({
      outcome: "definitive_failure",
      reason: "api_rejected",
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
  });

  it("reconciles an exact marker authored by the current Slack bot", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: { ok: true, messages: [recoveredMessage()] },
    });

    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "slack:C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({ outcome: "accepted", ts: DELIVERY_TS });

    expect(
      getCapturedSlackApiCalls("conversations.replies")[0]?.params,
    ).toEqual({
      channel: "C123",
      ts: THREAD_TS,
      oldest: OLDEST_TS,
      inclusive: "true",
      include_all_metadata: "true",
      limit: "15",
    });
  });

  it("ignores a forged human marker and metadata with extra payload fields", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: {
        ok: true,
        messages: [
          recoveredMessage({ botId: "", userId: "U_HUMAN" }),
          recoveredMessage({
            metadata: {
              event_type: "junior_delivery",
              event_payload: {
                locator: "abcdefghijklmnopqrstuv",
                part_index: 0,
                version: 1,
                conversation_id: "private-value",
              },
            },
          }),
        ],
      },
    });

    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({ outcome: "confirmed_absent" });
  });

  it("returns a cursor for a later rate-limited page invocation", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: {
        ok: true,
        messages: [],
        response_metadata: { next_cursor: "page-2" },
      },
    });
    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({ outcome: "continue", nextCursor: "page-2" });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);

    queueSlackApiResponse("conversations.replies", {
      body: { ok: true, messages: [recoveredMessage()] },
    });
    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
        cursor: "page-2",
      }),
    ).resolves.toEqual({ outcome: "accepted", ts: DELIVERY_TS });
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(2);
    expect(
      getCapturedSlackApiCalls("conversations.replies")[1]?.params.cursor,
    ).toBe("page-2");
  });

  it("carries Retry-After when reconciliation is rate limited", async () => {
    const before = Date.now();
    queueSlackRateLimit("conversations.replies");

    const result = await reconcileRecoverableSlackMessage({
      channelId: "C123",
      threadTs: THREAD_TS,
      oldestTs: OLDEST_TS,
      metadata: deliveryMetadata(),
    });

    expect(result).toMatchObject({ outcome: "retryable" });
    expect(
      result.outcome === "retryable" ? result.retryAtMs : undefined,
    ).toBeGreaterThanOrEqual(before);
    expect(getCapturedSlackApiCalls("conversations.replies")).toHaveLength(1);
  });

  it("fails closed when reconciliation is missing scope", async () => {
    queueSlackApiError("conversations.replies", {
      error: "missing_scope",
      needed: "channels:history",
    });
    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({
      outcome: "unresolved",
      reason: "permanent_provider_error",
      providerErrorCode: "missing_scope",
    });
  });

  it("confirms absence only after a successful final page with no match", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: { ok: true, messages: [] },
    });

    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({ outcome: "confirmed_absent" });
  });

  it("fails closed when Slack reports more pages without a cursor", async () => {
    queueSlackApiResponse("conversations.replies", {
      body: { ok: true, messages: [], has_more: true },
    });

    await expect(
      reconcileRecoverableSlackMessage({
        channelId: "C123",
        threadTs: THREAD_TS,
        oldestTs: OLDEST_TS,
        metadata: deliveryMetadata(),
      }),
    ).resolves.toEqual({ outcome: "unresolved" });
  });
});
